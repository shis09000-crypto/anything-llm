import { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import Admin from "@/models/admin";
import { FullScreenLoader } from "@/components/Preloader";
import { CaretRight, Flask } from "@phosphor-icons/react";
import { configurableFeatures } from "./features";
import ModalWrapper from "@/components/ModalWrapper";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function ExperimentalFeatures() {
  const [featureFlags, setFeatureFlags] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedFeature, setSelectedFeature] = useState(
    "experimental_live_file_sync"
  );
  const { t } = useTranslation();

  useEffect(() => {
    async function fetchSettings() {
      setLoading(true);
      const { settings } = await Admin.systemPreferencesByFields([
        "feature_flags",
      ]);
      setFeatureFlags(settings?.feature_flags ?? {});
      setLoading(false);
    }
    fetchSettings();
  }, []);

  const refresh = async () => {
    const { settings } = await Admin.systemPreferencesByFields([
      "feature_flags",
    ]);
    setFeatureFlags(settings?.feature_flags ?? {});
  };

  if (loading) {
    return (
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] w-full h-full flex justify-center items-center"
      >
        <FullScreenLoader />
      </div>
    );
  }

  return (
    <FeatureLayout>
      <div className="flex-1 flex gap-x-6 p-4 mt-10">
        {/* Feature settings nav */}
        <div className="flex flex-col gap-y-[18px]">
          <div className="text-white flex items-center gap-x-2">
            <Flask size={24} />
            <p className="text-lg font-medium">
              {t("experimental-features.title")}
            </p>
          </div>
          {/* Feature list */}
          <div className="bg-theme-bg-secondary text-white rounded-xl min-w-[360px] w-fit">
            {Object.values(configurableFeatures).map((feature, index) => {
              const isFirst = index === 0;
              const isLast =
                index === Object.values(configurableFeatures).length - 1;
              return (
                <FeatureItem
                  key={feature.key}
                  feature={feature}
                  isSelected={selectedFeature === feature.key}
                  isActive={featureFlags[feature.key]}
                  handleClick={setSelectedFeature}
                  t={t}
                  borderClass={[
                    ...(isFirst ? ["rounded-t-xl"] : []),
                    ...(isLast
                      ? ["rounded-b-xl"]
                      : ["border-b border-white/10"]),
                  ].join(" ")}
                />
              );
            })}
          </div>
        </div>

        {/* Selected feature setting panel */}
        <FeatureVerification>
          <div className="flex-[2] flex flex-col gap-y-[18px] mt-10">
            <div className="bg-theme-bg-secondary text-white rounded-xl flex-1 p-4">
              {selectedFeature ? (
                <SelectedFeatureComponent
                  feature={configurableFeatures[selectedFeature]}
                  settings={featureFlags}
                  refresh={refresh}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-white/60">
                  <Flask size={40} />
                  <p className="font-medium">
                    {t("experimental-features.selectFeature")}
                  </p>
                </div>
              )}
            </div>
          </div>
        </FeatureVerification>
      </div>
    </FeatureLayout>
  );
}

function FeatureLayout({ children }) {
  return (
    <div
      id="workspace-feature-settings-container"
      className="w-screen h-screen overflow-hidden bg-theme-bg-container flex md:mt-0 mt-6"
    >
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] w-full h-full flex"
      >
        {children}
      </div>
    </div>
  );
}

function FeatureItem({
  feature = {},
  isSelected = false,
  isActive = false,
  handleClick = () => {},
  borderClass = "border-b border-white/10",
  t,
}) {
  return (
    <div
      key={feature.key}
      className={`py-3 px-4 flex items-center justify-between cursor-pointer motion-hover hover:bg-white/5 ${borderClass} ${
        isSelected ? "bg-white/10 light:bg-theme-bg-sidebar" : ""
      }`}
      onClick={() => {
        if (feature?.href) window.location = feature.href;
        else handleClick?.(feature.key);
      }}
    >
      <div className="text-sm font-light">
        {feature.titleKey ? t(feature.titleKey) : feature.title}
      </div>
      <div className="flex items-center gap-x-2">
        {feature.autoEnabled ? (
          <>
            <div className="text-sm text-theme-text-secondary font-medium">
              {t("experimental-features.status.on")}
            </div>
            <div className="w-[14px]" />
          </>
        ) : (
          <>
            <div className="text-sm text-theme-text-secondary font-medium">
              {isActive
                ? t("experimental-features.status.on")
                : t("experimental-features.status.off")}
            </div>
            <CaretRight
              size={14}
              weight="bold"
              className="text-theme-text-secondary"
            />
          </>
        )}
      </div>
    </div>
  );
}

function SelectedFeatureComponent({ feature, settings, refresh }) {
  const Component = feature?.component;
  return Component ? (
    <Component
      enabled={settings[feature.key]}
      feature={feature.key}
      onToggle={refresh}
    />
  ) : null;
}

function FeatureVerification({ children }) {
  const { t } = useTranslation();

  if (
    !window.localStorage.getItem("anythingllm_tos_experimental_feature_set")
  ) {
    function acceptTos(e) {
      e.preventDefault();

      window.localStorage.setItem(
        "anythingllm_tos_experimental_feature_set",
        "accepted"
      );
      showToast(t("experimental-features.toasts.enabledSet"), "success");
      setTimeout(() => {
        window.location.reload();
      }, 2_500);
      return;
    }

    return (
      <>
        <ModalWrapper isOpen={true}>
          <div className="w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border overflow-hidden">
            <div className="relative p-6 border-b rounded-t border-theme-modal-border">
              <div className="flex items-center gap-2">
                <Flask size={24} className="text-theme-text-primary" />
                <h3 className="text-xl font-semibold text-white">
                  {t("experimental-features.tos.title")}
                </h3>
              </div>
            </div>
            <form onSubmit={acceptTos}>
              <div className="py-7 px-9 space-y-4 flex-col">
                <div className="w-full text-white text-md flex flex-col gap-y-4">
                  <p>
                    {t("experimental-features.tos.introStart")}
                    {t("experimental-features.tos.introSeparator")}
                    <b>{t("experimental-features.tos.optIn")}</b>
                    {t("experimental-features.tos.optInSuffix")}
                    {t("experimental-features.tos.introSeparator")}
                    {t("experimental-features.tos.introEnd")}
                  </p>

                  <div>
                    <p>{t("experimental-features.tos.risksIntro")}</p>
                    <ul className="list-disc ml-6 text-sm font-mono mt-2">
                      <li>{t("experimental-features.tos.risks.dataLoss")}</li>
                      <li>
                        {t("experimental-features.tos.risks.qualityChange")}
                      </li>
                      <li>
                        {t("experimental-features.tos.risks.storageIncrease")}
                      </li>
                      <li>
                        {t("experimental-features.tos.risks.resourceIncrease")}
                      </li>
                      <li>{t("experimental-features.tos.risks.cost")}</li>
                      <li>{t("experimental-features.tos.risks.bugs")}</li>
                    </ul>
                  </div>

                  <div>
                    <p>{t("experimental-features.tos.conditionsIntro")}</p>
                    <ul className="list-disc ml-6 text-sm font-mono mt-2">
                      <li>
                        {t(
                          "experimental-features.tos.conditions.futureRemoval"
                        )}
                      </li>
                      <li>
                        {t("experimental-features.tos.conditions.unstable")}
                      </li>
                      <li>
                        {t("experimental-features.tos.conditions.availability")}
                      </li>
                      <li>
                        {t("experimental-features.tos.conditions.privacyStart")}
                        {t(
                          "experimental-features.tos.conditions.privacySeparator"
                        )}
                        <b>
                          {t(
                            "experimental-features.tos.conditions.privacyBold"
                          )}
                        </b>
                        {t(
                          "experimental-features.tos.conditions.privacySeparator"
                        )}
                        {t("experimental-features.tos.conditions.privacyEnd")}
                      </li>
                      <li>
                        {t("experimental-features.tos.conditions.mayChange")}
                      </li>
                    </ul>
                  </div>

                  <p>
                    {t("experimental-features.tos.moreInfoPrefix")}{" "}
                    <a
                      href="https://docs.anythingllm.com/beta-preview/overview"
                      className="underline text-blue-500"
                    >
                      docs.anythingllm.com
                    </a>{" "}
                    {t("experimental-features.tos.moreInfoOrEmail")}{" "}
                    <a
                      href="mailto:team@mintplexlabs.com"
                      className="underline text-blue-500"
                    >
                      team@mintplexlabs.com
                    </a>
                  </p>
                </div>
              </div>
              <div className="flex w-full justify-between items-center p-6 space-x-2 border-t border-theme-modal-border rounded-b">
                <Link
                  to={paths.home()}
                  className="motion-hover bg-transparent text-white hover:bg-red-500/50 light:hover:bg-red-300/50 px-4 py-2 rounded-lg text-sm border border-theme-modal-border"
                >
                  {t("experimental-features.tos.reject")}
                </Link>
                <button
                  type="submit"
                  className="motion-hover bg-white text-black hover:opacity-60 px-4 py-2 rounded-lg text-sm border border-theme-modal-border"
                >
                  {t("experimental-features.tos.accept")}
                </button>
              </div>
            </form>
          </div>
        </ModalWrapper>
        {children}
      </>
    );
  }
  return <>{children}</>;
}
