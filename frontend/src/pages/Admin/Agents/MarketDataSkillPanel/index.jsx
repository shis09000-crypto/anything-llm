import React from "react";
import { useTranslation } from "react-i18next";
import Toggle from "@/components/lib/Toggle";
import { DefaultBadge } from "../Badges/default";

const MASKED_SECRET = "*".repeat(20);

function SecretField({ name, label, configured, required }) {
  return (
    <div className="flex flex-col w-full max-w-[360px]">
      <label className="text-theme-text-primary text-sm font-semibold block mb-2">
        {label}
      </label>
      <input
        type="password"
        name={`env::${name}`}
        className="border-none bg-theme-settings-input-bg text-theme-text-primary placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
        placeholder={label}
        defaultValue={configured ? MASKED_SECRET : ""}
        required={required}
        autoComplete="new-password"
        spellCheck={false}
      />
    </div>
  );
}

export default function MarketDataSkillPanel({
  title,
  description,
  icon,
  image,
  enabled = true,
  toggleSkill,
  skill,
  settings = {},
  configKind,
}) {
  const { t } = useTranslation();
  const credentials = [];
  if (configKind === "weather") {
    credentials.push({
      name: "QWeatherApiKey",
      label: t("agent.skill.marketData.qweatherKey"),
      configured: settings?.QWeatherApiKey === true,
    });
  }
  if (configKind === "global") {
    credentials.push(
      {
        name: "JuheStockApiKey",
        label: t("agent.skill.marketData.juheStockKey"),
        configured: settings?.JuheStockApiKey === true,
      },
      {
        name: "JuheForexApiKey",
        label: t("agent.skill.marketData.juheForexKey"),
        configured: settings?.JuheForexApiKey === true,
      }
    );
  }
  const allConfigured = credentials.every((item) => item.configured);

  return (
    <div className="p-2">
      <div className="flex flex-col gap-y-[18px] max-w-[560px]">
        <div className="flex w-full justify-between items-center">
          <div className="flex items-center gap-x-2">
            {icon &&
              React.createElement(icon, {
                size: 24,
                color: "var(--theme-text-primary)",
                weight: "bold",
              })}
            <label className="text-theme-text-primary text-md font-bold">
              {title}
            </label>
            <DefaultBadge title={title} />
          </div>
          <Toggle
            size="lg"
            enabled={enabled}
            onChange={() => toggleSkill(skill)}
          />
        </div>

        {image && <img src={image} alt={title} className="w-full rounded-md" />}
        <p className="text-theme-text-secondary text-opacity-60 text-xs font-medium">
          {description}
        </p>

        {credentials.length > 0 && (
          <div className="flex flex-col gap-y-4 rounded-xl border border-theme-sidebar-border p-4">
            <div className="flex items-center justify-between gap-x-3">
              <p className="text-theme-text-primary text-sm font-semibold">
                {t("agent.skill.marketData.credentials")}
              </p>
              <span
                className={`text-xs ${
                  allConfigured ? "text-green-400" : "text-yellow-400"
                }`}
              >
                {allConfigured
                  ? t("agent.skill.marketData.configured")
                  : t("agent.skill.marketData.notConfigured")}
              </span>
            </div>
            {credentials.map((credential) => (
              <SecretField
                key={credential.name}
                {...credential}
                required={enabled && !credential.configured}
              />
            ))}
            <p className="text-theme-text-secondary text-opacity-60 text-xs">
              {t("agent.skill.marketData.secretHelp")}
            </p>
          </div>
        )}

        <p className="text-theme-text-secondary text-opacity-60 text-xs font-medium">
          {t("agent.skill.default_skill")}
        </p>
      </div>
    </div>
  );
}
