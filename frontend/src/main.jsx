const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
const loginOnlyRoute = pathname === "/login" || pathname === "/sso/simple";

if (loginOnlyRoute) {
  void import("./login-main.jsx");
} else {
  window.queueMicrotask(() => {
    void import("./application-main.jsx");
  });
}
