import {
  Archive,
  ChatCircleText,
  FileArrowDown,
  ShieldCheck,
  Trash,
} from "@phosphor-icons/react";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import showToast from "@/utils/toast";
import AccountSettingRow from "./AccountSettingRow";
import AccountSettingsApi from "./accountSettingsApi";
import { CardHeader } from "./ContactMethodsCard";

export default function DataPrivacyCard() {
  async function exportAccountData() {
    await AccountSettingsApi.exportAccountData();
    showToast("导出账户数据接口已预留。", "info");
  }

  async function exportChatRecords() {
    await AccountSettingsApi.exportChatRecords();
    showToast("导出聊天记录接口已预留。", "info");
  }

  async function requestDeletion() {
    const confirmed = await showAppConfirm({
      tone: "danger",
      title: "删除账户？",
      description: "此操作第一版仅预留入口，不会真正删除账户数据。",
      confirmText: "确认",
      cancelText: "取消",
    });
    if (!confirmed) return;
    await AccountSettingsApi.requestAccountDeletion();
    showToast("删除账户流程入口已预留。", "info");
  }

  return (
    <section id="privacy" className="account-card">
      <CardHeader
        title="数据与隐私"
        subtitle="导出数据、查看安全记录或发起账户删除流程。"
      />
      <div className="divide-y divide-slate-100">
        <AccountSettingRow
          icon={<FileArrowDown className="h-5 w-5" />}
          title="导出账户数据"
          subtitle="导出个人资料、联系方式和账号配置。"
          onClick={exportAccountData}
        />
        <AccountSettingRow
          icon={<ChatCircleText className="h-5 w-5" />}
          title="导出聊天记录"
          subtitle="导出你有权限访问的聊天历史。"
          onClick={exportChatRecords}
        />
        <AccountSettingRow
          icon={<ShieldCheck className="h-5 w-5" />}
          title="安全审计记录"
          subtitle="查看登录、安全设置和账号变更记录。"
          status={
            <span className="font-semibold text-slate-400">入口预留</span>
          }
        />
        <AccountSettingRow
          icon={<Archive className="h-5 w-5" />}
          title="数据保留"
          subtitle="账户数据遵循本地部署的数据保留策略。"
          status={<span className="font-semibold text-slate-500">默认</span>}
        />
        <AccountSettingRow
          icon={<Trash className="h-5 w-5" />}
          title="删除账户"
          subtitle="删除账户需要独立确认和后端安全流程。"
          danger
          onClick={requestDeletion}
        />
      </div>
    </section>
  );
}
