import React, { useEffect, useRef } from "react";
import AthenaAmbientScene from "./AthenaAmbientScene";
import "./animations.css";

export default function LoginBackground() {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (
      !root ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let frame = 0;
    const updateParallax = (event) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const x = event.clientX / window.innerWidth - 0.5;
        const y = event.clientY / window.innerHeight - 0.5;
        root.style.setProperty("--login-scene-x", `${x * -6}px`);
        root.style.setProperty("--login-scene-y", `${y * -5}px`);
        root.style.setProperty("--login-orb-x", `${x * 18}px`);
        root.style.setProperty("--login-orb-y", `${y * 12}px`);
      });
    };
    const resetParallax = () => {
      root.style.setProperty("--login-scene-x", "0px");
      root.style.setProperty("--login-scene-y", "0px");
      root.style.setProperty("--login-orb-x", "0px");
      root.style.setProperty("--login-orb-y", "0px");
    };

    window.addEventListener("pointermove", updateParallax, { passive: true });
    window.addEventListener("blur", resetParallax);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", updateParallax);
      window.removeEventListener("blur", resetParallax);
    };
  }, []);

  return (
    <div ref={rootRef} className="soft-login-background" aria-hidden="true">
      <div className="soft-login-scene-stage">
        <div className="soft-login-background-image" />
        <div className="soft-login-orb-parallax">
          <div className="soft-login-orb-float">
            <span className="soft-login-orb-caustic" />
            <span className="soft-login-orbit-ring soft-login-orbit-ring-one" />
            <span className="soft-login-orbit-ring soft-login-orbit-ring-two" />
            <img
              src="/login/athena-knowledge-orb.png"
              alt=""
              className="soft-login-knowledge-orb"
            />
            <span className="soft-login-orb-refraction" />
          </div>
        </div>
      </div>
      <div className="soft-login-background-light" />
      <AthenaAmbientScene />
    </div>
  );
}
