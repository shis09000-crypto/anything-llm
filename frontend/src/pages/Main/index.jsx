import React from "react";
import PasswordModal, {
  AuthBootstrapError,
  usePasswordModal,
} from "@/components/Modals/Password";
import { FullScreenLoader } from "@/components/Preloader";
import Home from "./Home";
import Sidebar from "@/components/Sidebar";
import { mobileRuntimeActive } from "@/utils/mobileRuntime";

const MobileWebPwa = React.lazy(() =>
  import("@/components/MobileWeb").then((module) => ({
    default: module.MobileWebPwa,
  }))
);

export default function Main() {
  const { loading, requiresAuth, mode, error } = usePasswordModal();

  if (loading) return <FullScreenLoader />;
  if (error) return <AuthBootstrapError message={error} />;
  if (requiresAuth !== false)
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;

  if (mobileRuntimeActive()) {
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
