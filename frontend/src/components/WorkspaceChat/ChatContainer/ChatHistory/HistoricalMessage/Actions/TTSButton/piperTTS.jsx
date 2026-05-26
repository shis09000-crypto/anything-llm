import { useEffect, useState, useRef } from "react";
import { SpeakerHigh, PauseCircle, CircleNotch } from "@phosphor-icons/react";
import PiperTTSClient, { revokeTtsBlobUrl } from "@/utils/piperTTS";
import messageToSpeech from "@/utils/chat/messageToSpeech";

export default function PiperTTS({ chatId, voiceId = null, message }) {
  const playerRef = useRef(null);
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [audioSrc, setAudioSrc] = useState(null);
  const audioSrcRef = useRef(null);

  function releaseAudioSrc(url = audioSrcRef.current, updateState = true) {
    if (!url) return;
    revokeTtsBlobUrl(url);
    audioSrcRef.current = null;
    if (updateState) setAudioSrc(null);
  }

  async function speakMessage(e) {
    e.preventDefault();
    if (speaking) {
      playerRef?.current?.pause();
      return;
    }

    try {
      if (!audioSrc) {
        setLoading(true);
        const client = new PiperTTSClient({ voiceId });
        const blobUrl = await client.getAudioBlobForText(
          messageToSpeech(message)
        );
        releaseAudioSrc();
        if (blobUrl) {
          audioSrcRef.current = blobUrl;
          setAudioSrc(blobUrl);
        }
        setLoading(false);
      } else {
        playerRef.current.play();
      }
    } catch (e) {
      console.error(e);
      setLoading(false);
      setSpeaking(false);
    }
  }

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onPlay = () => setSpeaking(true);
    const onPause = () => {
      player.currentTime = 0;
      setSpeaking(false);
    };
    const onEnded = () => {
      setSpeaking(false);
      releaseAudioSrc();
    };
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    return () => {
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ended", onEnded);
      releaseAudioSrc(audioSrcRef.current, false);
    };
  }, []);

  return (
    <div className="mt-3 relative">
      <button
        type="button"
        onClick={speakMessage}
        disabled={loading}
        data-auto-play-chat-id={chatId}
        data-tooltip-id="message-to-speech"
        data-tooltip-content={
          speaking ? "Pause TTS speech of message" : "TTS Speak message"
        }
        className="border-none text-[var(--theme-sidebar-footer-icon-fill)]"
        aria-label={speaking ? "Pause speech" : "Speak message"}
      >
        {speaking ? (
          <PauseCircle size={18} className="mb-1" />
        ) : (
          <>
            {loading ? (
              <CircleNotch size={18} className="mb-1 animate-spin" />
            ) : (
              <SpeakerHigh size={18} className="mb-1" />
            )}
          </>
        )}
        <audio
          ref={playerRef}
          hidden={true}
          src={audioSrc}
          autoPlay={true}
          controls={false}
        />
      </button>
    </div>
  );
}
