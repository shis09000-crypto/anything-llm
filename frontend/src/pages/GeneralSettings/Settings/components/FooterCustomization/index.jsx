import React, { useState, useEffect } from "react";
import showToast from "@/utils/toast";
import { safeJsonParse } from "@/utils/request";
import NewIconForm from "./NewIconForm";
import Admin from "@/models/admin";
import System from "@/models/system";
import { useTranslation } from "react-i18next";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

export default function FooterCustomization() {
  const [footerIcons, setFooterIcons] = useState(Array(3).fill(null));
  const { t } = useTranslation();

  useEffect(() => {
    async function fetchFooterIcons() {
      const { settings } = await Admin.systemPreferencesByFields([
        "footer_data",
      ]);

      const footerData = settings?.footer_data;
      if (footerData) {
        const parsedIcons = safeJsonParse(footerData, []);
        setFooterIcons((prevIcons) => {
          const updatedIcons = [...prevIcons];
          parsedIcons.forEach((icon, index) => {
            updatedIcons[index] = icon;
          });
          return updatedIcons;
        });
      }
    }
    fetchFooterIcons();
  }, []);

  const updateFooterIcons = async (updatedIcons) => {
    const previousIcons = footerIcons;
    const action = optimisticActionCenter.run({
      type: "settings.footerIcons.save",
      scope: {
        route: "settings",
        surface: "customization",
        setting: "footer_data",
      },
      priority: "P1",
      policy: "visible",
      intentRank: 0,
      protected: true,
      abortable: false,
      label: "optimistic:settings-footer-icons",
      optimisticPatch: () => {
        setFooterIcons(updatedIcons);
        window.localStorage.removeItem(System.cacheKeys.footerIcons);
      },
      rollbackPatch: () => setFooterIcons(previousIcons),
      serverCall: async ({ signal }) => {
        const result = await Admin.updateSystemPreferences(
          {
            footer_data: JSON.stringify(
              updatedIcons.filter((icon) => icon !== null)
            ),
          },
          {
            signal,
            task: false,
          }
        );
        if (!result?.success)
          throw new Error(result?.error || "Failed to update footer icons");
        return result;
      },
    });
    const outcome = await action.promise;
    if (!outcome.ok) {
      showToast(
        `Failed to update footer icons - ${outcome.error?.message}`,
        "error",
        {
          clear: true,
        }
      );
      return;
    }

    showToast("Successfully updated footer icons.", "success", { clear: true });
  };

  const handleRemoveIcon = (index) => {
    const updatedIcons = [...footerIcons];
    updatedIcons[index] = null;
    updateFooterIcons(updatedIcons);
  };

  return (
    <div className="flex flex-col gap-y-0.5 my-4">
      <p className="text-sm leading-6 font-semibold text-white">
        {t("customization.items.sidebar-footer.title")}
      </p>
      <p className="text-xs text-white/60">
        {t("customization.items.sidebar-footer.description")}
      </p>
      <div className="mt-2 flex gap-x-3 font-medium text-white text-sm">
        <div>{t("customization.items.sidebar-footer.icon")}</div>
        <div>{t("customization.items.sidebar-footer.link")}</div>
      </div>
      <div className="mt-2 flex flex-col gap-y-[10px]">
        {footerIcons.map((icon, index) => (
          <NewIconForm
            key={index}
            icon={icon?.icon}
            url={icon?.url}
            onSave={(newIcon, newUrl) => {
              const updatedIcons = [...footerIcons];
              updatedIcons[index] = { icon: newIcon, url: newUrl };
              updateFooterIcons(updatedIcons);
            }}
            onRemove={() => handleRemoveIcon(index)}
          />
        ))}
      </div>
    </div>
  );
}
