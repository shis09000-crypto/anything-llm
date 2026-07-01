import { useEffect, useMemo, useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { getStoredAuthUser, setStoredAuthUser } from "@/utils/authUserStorage";
import AppButton from "@/components/lib/AppButton";
import showToast from "@/utils/toast";
import AccountSettingsApi from "./accountSettingsApi";

const PERSONALIZATION_OPEN_TAG = "<personalization_profile>";
const PERSONALIZATION_CLOSE_TAG = "</personalization_profile>";
const MAX_BIO_LENGTH = 1000;

const TOP_FIELD_CONFIG = [
  {
    key: "nickname",
    label: "你的昵称",
    multiline: false,
    placeholder: "例如：shijie / 老师 / 小王",
  },
  {
    key: "identity",
    label: "模型的身份",
    multiline: false,
    placeholder: "例如：导师、研究助理、产品顾问、投资分析师",
  },
  {
    key: "style",
    label: "风格",
    multiline: false,
    placeholder: "例如：直接、细致、像导师一样追问重点，少讲客套话",
  },
];

const DETAILS_FIELD_CONFIG = {
  key: "details",
  label: "你的详情",
  multiline: true,
  placeholder: "例如：我关注金融史、知识图谱和长期学习，希望回答有结构、有判断",
};

const PERSONALIZATION_LABELS = ["你的昵称", "模型的身份", "风格", "你的详情"];

const EMPTY_PERSONALIZATION = {
  style: "",
  nickname: "",
  identity: "",
  details: "",
};

export default function PersonalizationCard({ user, onUserUpdated }) {
  const [draft, setDraft] = useState(() => parsePersonalizationBio(user?.bio));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(parsePersonalizationBio(user?.bio));
  }, [user?.bio]);

  const serializedBio = useMemo(
    () => serializePersonalizationBio(draft),
    [draft]
  );
  const remainingCharacters = MAX_BIO_LENGTH - serializedBio.length;
  const isOverLimit = remainingCharacters < 0;

  function updateField(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function savePersonalization() {
    if (isOverLimit) {
      showToast("个性化设置内容过长，请精简后再保存。", "error", {
        clear: true,
      });
      return;
    }

    setSaving(true);
    const result = await AccountSettingsApi.updateProfile({
      bio: serializedBio,
    });
    setSaving(false);

    if (!result.success) {
      showToast(`保存个性化设置失败：${result.error}`, "error", {
        clear: true,
      });
      return;
    }

    const storedUser = getStoredAuthUser();
    const nextUser = {
      ...(storedUser || user),
      bio: serializedBio,
    };
    setStoredAuthUser(nextUser);
    onUserUpdated?.(nextUser);
    showToast("个性化设置已保存。", "success", { clear: true });
  }

  return (
    <section id="personalization" className="account-card">
      <div className="mb-5 flex flex-col gap-3 px-1 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-600">
            <Sparkle className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">个性化设置</h2>
            <p className="mt-1 text-sm leading-5 text-slate-500">
              这些内容会作为你的个人偏好保存，让模型更了解你的交流方式和背景。
            </p>
          </div>
        </div>
        <AppButton
          type="button"
          size="sm"
          disabled={saving || isOverLimit}
          loading={saving}
          onClick={savePersonalization}
        >
          保存
        </AppButton>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {TOP_FIELD_CONFIG.map((field) => (
          <PersonalizationField
            key={field.key}
            field={field}
            value={draft[field.key]}
            onChange={(value) => updateField(field.key, value)}
          />
        ))}
      </div>
      <div className="mt-4">
        <PersonalizationField
          field={DETAILS_FIELD_CONFIG}
          value={draft.details}
          onChange={(value) => updateField("details", value)}
        />
      </div>

      <div
        className={[
          "mt-4 px-1 text-xs leading-5",
          isOverLimit ? "text-red-500" : "text-slate-400",
        ].join(" ")}
      >
        {isOverLimit
          ? `已超过 ${Math.abs(remainingCharacters)} 个字符。`
          : `还可保存约 ${remainingCharacters} 个字符。`}
      </div>
    </section>
  );
}

function PersonalizationField({ field, value, onChange }) {
  const sharedClassName =
    "w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-950 outline-none placeholder:text-slate-400 focus:border-sky-400";

  return (
    <label className="grid gap-2 text-sm font-semibold text-slate-700">
      {field.label}
      {field.multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          className={`${sharedClassName} min-h-[116px] resize-y`}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          className={sharedClassName}
        />
      )}
    </label>
  );
}

function parsePersonalizationBio(bio = "") {
  const rawBio = normalizePersonalizationBioLabels(bio);
  const match = rawBio.match(
    new RegExp(
      `${escapeRegExp(PERSONALIZATION_OPEN_TAG)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(PERSONALIZATION_CLOSE_TAG)}`
    )
  );
  if (!match) return { ...EMPTY_PERSONALIZATION, details: rawBio };

  const content = match[1] || "";
  return {
    style: extractFieldValue(content, "风格"),
    nickname: extractFieldValue(content, "你的昵称"),
    identity: extractFieldValue(content, "模型的身份"),
    details: extractFieldValue(content, "你的详情"),
  };
}

function serializePersonalizationBio(profile = EMPTY_PERSONALIZATION) {
  return [
    PERSONALIZATION_OPEN_TAG,
    `你的昵称: ${String(profile.nickname || "").trim()}`,
    `模型的身份: ${String(profile.identity || "").trim()}`,
    `风格: ${String(profile.style || "").trim()}`,
    `你的详情: ${String(profile.details || "").trim()}`,
    PERSONALIZATION_CLOSE_TAG,
  ].join("\n");
}

function extractFieldValue(content = "", label = "") {
  const labelBoundary = PERSONALIZATION_LABELS.map(escapeRegExp).join("|");
  const match = String(content).match(
    new RegExp(
      `${escapeRegExp(label)}:\\s*([\\s\\S]*?)(?=\\n(?:${labelBoundary}):|$)`
    )
  );
  return match ? match[1].trim() : "";
}

function normalizePersonalizationBioLabels(bio = "") {
  return String(bio || "").replace(/^你的身份:/gm, "模型的身份:");
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
