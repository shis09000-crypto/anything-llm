import React, { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { FullScreenLoader } from "@/components/Preloader";
import Invite from "@/models/invite";
import NewUserModal from "./NewUserModal";
import ModalWrapper from "@/components/ModalWrapper";

export default function InvitePage() {
  const { code } = useParams();
  const [searchParams] = useSearchParams();
  const inviteToken = code || searchParams.get("token") || "";
  const [result, setResult] = useState({
    status: "loading",
    message: null,
    invite: null,
  });

  useEffect(() => {
    async function checkInvite() {
      if (!inviteToken) {
        setResult({
          status: "invalid",
          message: "No invite code provided.",
          invite: null,
        });
        return;
      }
      const { invite, error } = await Invite.checkInvite(inviteToken);
      setResult({
        status: invite ? "valid" : "invalid",
        message: error,
        invite,
      });
    }
    checkInvite();
  }, [inviteToken]);

  if (result.status === "loading") {
    return (
      <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
        <FullScreenLoader />
      </div>
    );
  }

  if (result.status === "invalid") {
    return (
      <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex items-center justify-center">
        <p className="text-red-400 text-lg">{result.message}</p>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex items-center justify-center">
      <ModalWrapper isOpen={true}>
        <NewUserModal invite={result.invite} inviteToken={inviteToken} />
      </ModalWrapper>
    </div>
  );
}
