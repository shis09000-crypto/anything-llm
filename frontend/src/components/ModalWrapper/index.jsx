import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useMotion } from "@/contexts/MotionProvider";

/**
 * @typedef {Object} ModalWrapperProps
 * @property {import("react").ReactComponentElement} children - The DOM/JSX to render
 * @property {boolean} isOpen - Option that renders the modal
 * @property {boolean} noPortal - (default: false) Used for creating sub-DOM modals that need to be rendered as a child element instead of a modal placed at the root
 * Note: This can impact the bg-overlay presentation due to conflicting DOM positions so if using this property you should
   double check it renders as desired.
 */

/**
 *
 * @param {ModalWrapperProps} props - ModalWrapperProps to pass
 * @returns {import("react").ReactNode}
 *
 * @todo Add a closeModal prop to the ModalWrapper component so we can escape dismiss anywhere this is used
 */
export default function ModalWrapper({ children, isOpen, noPortal = false }) {
  const { requestMotion, reducedMotion } = useMotion();
  const [animateModal, setAnimateModal] = useState(false);

  useEffect(() => {
    if (!isOpen || reducedMotion) {
      setAnimateModal(false);
      return;
    }
    const motion = requestMotion({
      category: "modal",
      token: "motion-modal",
      duration: 360,
    });
    setAnimateModal(motion.allowed);
  }, [isOpen, reducedMotion, requestMotion]);

  if (!isOpen) return null;

  const modal = (
    <div
      className={`motion-modal-overlay bg-black/60 backdrop-blur-sm fixed top-0 left-0 outline-none w-screen h-screen flex items-center justify-center z-99 ${
        animateModal ? "motion-modal-open" : ""
      }`}
    >
      <div className={animateModal ? "motion-modal-content" : ""}>
        {children}
      </div>
    </div>
  );

  if (noPortal) {
    return modal;
  }

  return createPortal(modal, document.getElementById("root"));
}
