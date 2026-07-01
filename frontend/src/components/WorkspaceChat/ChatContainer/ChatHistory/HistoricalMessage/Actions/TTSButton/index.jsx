import { lazy, Suspense } from "react";
import { useTTSProvider } from "@/components/contexts/TTSProvider";
import NativeTTSMessage from "./native";
import AsyncTTSMessage from "./asyncTts";

const PiperTTSMessage = lazy(() => import("./piperTTS"));

function WrapTTS({ children }) {
  return <div className="mx-2">{children}</div>;
}

export default function TTSMessage({
  slug,
  chatId,
  publicChatId = null,
  message,
}) {
  const { settings, provider, loading } = useTTSProvider();
  if (!chatId || loading) return null;
  const actionChatId = publicChatId || chatId;

  switch (provider) {
    case "openai":
    case "generic-openai":
    case "elevenlabs":
      return (
        <WrapTTS>
          <AsyncTTSMessage chatId={actionChatId} slug={slug} />
        </WrapTTS>
      );
    case "piper_local":
      return (
        <WrapTTS>
          <Suspense fallback={null}>
            <PiperTTSMessage
              chatId={chatId}
              voiceId={settings?.TTSPiperTTSVoiceModel}
              message={message}
            />
          </Suspense>
        </WrapTTS>
      );
    default:
      return (
        <WrapTTS>
          <NativeTTSMessage chatId={chatId} message={message} />
        </WrapTTS>
      );
  }
}
