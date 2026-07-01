import { useTranslation } from "react-i18next";
import LanguagePreference from "../components/LanguagePreference";
import ThemePreference from "../components/ThemePreference";
import MotionDensityPreference from "../components/MotionDensityPreference";
import ReadingToolsPreference from "@/components/ReadingToolsPreference";
import { SoftCard, SoftSettingsLayout } from "@/components/SoftSettings";

export default function InterfaceSettings() {
  const { t } = useTranslation();
  return (
    <SoftSettingsLayout
      title={t("customization.interface.title")}
      description={t("customization.interface.description")}
    >
      <SoftCard>
        <ThemePreference />
        <MotionDensityPreference />
        <ReadingToolsPreference className="my-8" />
        <LanguagePreference />
      </SoftCard>
    </SoftSettingsLayout>
  );
}
