import { useState, useEffect, useRef } from "react";
import PiperTTSClient, { revokeTtsBlobUrl } from "@/utils/piperTTS";
import { titleCase } from "text-case";
import { humanFileSize } from "@/utils/numbers";
import showToast from "@/utils/toast";
import { CircleNotch, PauseCircle, PlayCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

export default function PiperTTSOptions({ settings }) {
  const { t } = useTranslation();

  return (
    <>
      <p className="text-sm font-base text-white text-opacity-60 mb-4">
        {t("audio-preference.piper.description")}
      </p>
      <div className="flex gap-x-4 items-center">
        <PiperTTSModelSelection settings={settings} />
      </div>
    </>
  );
}

function voicesByLanguage(voices = []) {
  const voicesByLanguage = voices.reduce((acc, voice) => {
    const langName = voice?.language?.name_english ?? "Unlisted";
    acc[langName] = acc[langName] || [];
    acc[langName].push(voice);
    return acc;
  }, {});
  return Object.entries(voicesByLanguage);
}

function voiceDisplayName(voice) {
  const { is_stored, name, quality, files } = voice;
  const onnxFileKey = Object.keys(files).find((key) => key.endsWith(".onnx"));
  const fileSize = files?.[onnxFileKey]?.size_bytes || 0;
  return `${is_stored ? "✔ " : ""}${titleCase(name)}-${quality === "low" ? "Low" : "HQ"} (${humanFileSize(fileSize)})`;
}

function PiperTTSModelSelection({ settings }) {
  const [loading, setLoading] = useState(true);
  const [voices, setVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState(
    settings?.TTSPiperTTSVoiceModel
  );
  const { t } = useTranslation();

  function flushVoices() {
    PiperTTSClient.flush()
      .then(() =>
        showToast(t("audio-preference.piper.toasts.flushed"), "info", {
          clear: true,
        })
      )
      .catch((e) => console.error(e));
  }

  useEffect(() => {
    PiperTTSClient.voices()
      .then((voices) => {
        if (voices?.length !== 0) return setVoices(voices);
        throw new Error("Could not fetch voices from web worker.");
      })
      .catch((e) => {
        console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col w-60">
        <label className="text-white text-sm font-semibold block mb-3">
          {t("audio-preference.fields.voiceModelSelection")}
        </label>
        <select
          name="TTSPiperTTSVoiceModel"
          value=""
          disabled={true}
          className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
        >
          <option value="" disabled={true}>
            {t("audio-preference.loadingModels")}
          </option>
        </select>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-fit">
      <div className="flex flex-col w-60">
        <label className="text-white text-sm font-semibold block mb-3">
          {t("audio-preference.fields.voiceModelSelection")}
        </label>
        <div className="flex items-center w-fit gap-x-4 mb-2">
          <select
            name="TTSPiperTTSVoiceModel"
            required={true}
            onChange={(e) => setSelectedVoice(e.target.value)}
            value={selectedVoice}
            className="border-none flex-shrink-0 bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
          >
            {voicesByLanguage(voices).map(([lang, voices]) => {
              return (
                <optgroup key={lang} label={lang}>
                  {voices.map((voice) => (
                    <option key={voice.key} value={voice.key}>
                      {voiceDisplayName(voice)}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <DemoVoiceSample voiceId={selectedVoice} />
        </div>
        <p className="text-xs text-white/40">
          {t("audio-preference.piper.storedModelHint")}
        </p>
      </div>
      {!!voices.find((voice) => voice.is_stored) && (
        <button
          type="button"
          onClick={flushVoices}
          className="w-fit border-none hover:text-white hover:underline text-white/40 text-sm my-4"
        >
          {t("audio-preference.piper.flushCache")}
        </button>
      )}
    </div>
  );
}

function DemoVoiceSample({ voiceId }) {
  const playerRef = useRef(null);
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [audioSrc, setAudioSrc] = useState(null);
  const audioSrcRef = useRef(null);
  const { t } = useTranslation();

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
          "Hello, welcome to AnythingLLM!"
        );
        releaseAudioSrc();
        if (blobUrl) {
          audioSrcRef.current = blobUrl;
          setAudioSrc(blobUrl);
        }
        setLoading(false);
        client.worker?.terminate();
        PiperTTSClient._instance = null;
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
      releaseAudioSrc();
    };
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    return () => {
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      releaseAudioSrc(audioSrcRef.current, false);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={speakMessage}
      disabled={loading}
      className="border-none text-zinc-300 flex items-center gap-x-1"
    >
      {speaking ? (
        <>
          <PauseCircle size={20} className="flex-shrink-0" />
          <p className="text-sm flex-shrink-0">
            {t("audio-preference.piper.stopDemo")}
          </p>
        </>
      ) : (
        <>
          {loading ? (
            <>
              <CircleNotch size={20} className="animate-spin flex-shrink-0" />
              <p className="text-sm flex-shrink-0">
                {t("audio-preference.piper.loadingVoice")}
              </p>
            </>
          ) : (
            <>
              <PlayCircle size={20} className="flex-shrink-0 text-white" />
              <p className="text-white text-sm flex-shrink-0">
                {t("audio-preference.piper.playSample")}
              </p>
            </>
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
  );
}
