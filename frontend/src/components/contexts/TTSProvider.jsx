import { createContext, useContext, useEffect, useState } from "react";
import System from "@/models/system";
import Appearance from "@/models/appearance";

const ASSISTANT_MESSAGE_COMPLETE_EVENT = "ASSISTANT_MESSAGE_COMPLETE_EVENT";
const TTSProviderContext = createContext();

/**
 * 该组件用于向应用提供 TTS provider context。
 *
 * TODO: 这个 context provider 目前只是对 System.keys() 调用做了一层包装，
 * 用来获取 TTS provider 设置。
 * 不过，我们在很多地方都使用了 .keys()，因此更合理的做法可能是创建一个通用 hook，
 * 只要需要从 System 获取任意设置，就可以获取 keys() 并按需复用。
 *
 * 目前由于 TTSButtons 会在每条消息上渲染，为了减少大量请求，
 * 暂时在这里使用这个 hook，这样就可以在聊天容器中复用 TTS 设置。
 */
export function TTSProvider({ children }) {
  const [settings, setSettings] = useState({});
  const [provider, setProvider] = useState("native");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function getSettings() {
      const _settings = await System.keys();
      setProvider(_settings?.TextToSpeechProvider ?? "native");
      setSettings(_settings);
      setLoading(false);
    }
    getSettings();
  }, []);

  return (
    <TTSProviderContext.Provider
      value={{
        settings,
        provider,
        loading,
      }}
    >
      {children}
    </TTSProviderContext.Provider>
  );
}

/**
 * 该 hook 用于便捷获取 TTS provider 设置，
 * 避免每个组件挂载时都重新通过 System.keys() 获取设置。
 *
 * @returns {{settings: {TTSPiperTTSVoiceModel: string|null}, provider: string, loading: boolean}} TTS provider 设置。
 */
export function useTTSProvider() {
  const context = useContext(TTSProviderContext);
  if (!context)
    throw new Error("useTTSProvider must be used within a TTSProvider");
  return context;
}

/**
 * 该函数会触发 ASSISTANT_MESSAGE_COMPLETE_EVENT 事件。
 *
 * 该事件用于通知 TTSProvider：某条消息已经完整生成；
 * 如果用户启用了对应设置，则应播放 TTS 响应。
 *
 * @param {string} chatId - 已完整生成的消息对应的 chatId。
 */
export function emitAssistantMessageCompleteEvent(chatId) {
  window.dispatchEvent(
    new CustomEvent(ASSISTANT_MESSAGE_COMPLETE_EVENT, { detail: { chatId } })
  );
}

/**
 * 该 hook 会为 ASSISTANT_MESSAGE_COMPLETE_EVENT 事件建立监听器。
 * 当事件被触发时，该 hook 会尝试播放给定 chatId 对应的 TTS 响应。
 * 它会不断尝试播放该 chatId 对应的 TTS 响应，
 * 直到播放成功或达到最大尝试次数。
 *
 * 实现方式是查找带有 data-auto-play-chat-id 属性、
 * 且该属性值与 chatId 匹配的按钮。
 */
export function useWatchForAutoPlayAssistantTTSResponse() {
  const autoPlayAssistantTtsResponse = Appearance.get(
    "autoPlayAssistantTtsResponse"
  );

  function handleAutoPlayTTSEvent(event) {
    let autoPlayAttempts = 0;
    const { chatId } = event.detail;

    /**
     * 尝试播放给定 chatId 对应的 TTS 响应。
     * 这是一个递归函数，会持续尝试播放给定 chatId 对应的 TTS 响应，
     * 直到播放成功或达到最大尝试次数。
     * @returns {boolean} 如果 TTS 响应已播放则返回 true，否则返回 false。
     */
    function attemptToPlay() {
      const playBtn = document.querySelector(
        `[data-auto-play-chat-id="${chatId}"]`
      );
      if (!playBtn) {
        autoPlayAttempts++;
        if (autoPlayAttempts > 3) return false;
        setTimeout(() => {
          attemptToPlay();
        }, 1000 * autoPlayAttempts);
        return false;
      }
      playBtn.click();
      return true;
    }
    setTimeout(() => {
      attemptToPlay();
    }, 800);
  }

  // 只有在用户启用了 autoPlayAssistantTtsResponse 设置时，
  // 才需要监听这些事件。
  useEffect(() => {
    if (autoPlayAssistantTtsResponse) {
      window.addEventListener(
        ASSISTANT_MESSAGE_COMPLETE_EVENT,
        handleAutoPlayTTSEvent
      );
      return () => {
        window.removeEventListener(
          ASSISTANT_MESSAGE_COMPLETE_EVENT,
          handleAutoPlayTTSEvent
        );
      };
    } else {
      console.log("Assistant TTS auto-play is disabled");
    }
  }, [autoPlayAssistantTtsResponse]);
}
