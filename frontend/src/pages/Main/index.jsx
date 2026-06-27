import React from "react";
import PasswordModal, { usePasswordModal } from "@/components/Modals/Password";
import { FullScreenLoader } from "@/components/Preloader";
import Home from "./Home";
import { isMobile } from "react-device-detect";
import Sidebar from "@/components/Sidebar";

const MobileWebPwa = React.lazy(() =>
  import("@/components/MobileWeb").then((module) => ({
    default: module.MobileWebPwa,
  }))
);

export default function Main() {
  const { loading, requiresAuth, mode } = usePasswordModal();

  if (loading) return <FullScreenLoader />;
  if (requiresAuth !== false)
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;

  if (isMobile) {
    return (
      <React.Suspense fallback={<FullScreenLoader />}>
        <MobileWebPwa />
      </React.Suspense>
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex">
      <Sidebar />
      <Home />
    </div>
  );
}
