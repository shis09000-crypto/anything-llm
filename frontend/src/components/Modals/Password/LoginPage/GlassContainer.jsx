import React from "react";

export default function GlassContainer({ children, className = "" }) {
  return (
    <section className={`soft-login-card ${className}`.trim()}>
      {children}
    </section>
  );
}
