import { useEffect, useState } from "react";
import { FullScreenLoader } from "@/components/Preloader";
import System from "@/models/system";
import paths from "@/utils/paths";
import { useNavigate } from "react-router-dom";

/**
 * 保护当前视图，避免无法查看聊天历史的系统配置访问该页面。
 * 如果用户无法查看聊天历史，则会被重定向到首页。
 * @param {React.ReactNode} children
 */
export function CanViewChatHistory({ children }) {
  const { loading, viewable } = useCanViewChatHistory();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !viewable) navigate(paths.home(), { replace: true });
  }, [loading, navigate, viewable]);

  if (loading) return <FullScreenLoader />;
  if (!viewable) {
    return <FullScreenLoader />;
  }

  return <>{children}</>;
}

/**
 * 向 children 提供 `viewable` 状态。
 * @returns {React.ReactNode}
 */
export function CanViewChatHistoryProvider({ children }) {
  const { loading, viewable } = useCanViewChatHistory();
  if (loading) return null;
  return <>{children({ viewable })}</>;
}

/**
 * 从 local storage 或系统设置中获取是否可以查看聊天历史的状态。
 * @returns {Promise<{viewable: boolean, error: string | null}>}
 */
export function useCanViewChatHistory() {
  const [loading, setLoading] = useState(true);
  const [viewable, setViewable] = useState(false);

  useEffect(() => {
    async function fetchViewable() {
      const { viewable } = await System.fetchCanViewChatHistory();
      setViewable(viewable);
      setLoading(false);
    }
    fetchViewable();
  }, []);

  return { loading, viewable };
}
