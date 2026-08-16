import CharacterPerformanceLab from "@/pages/GeneralSettings/Settings/CharacterPerformanceLab";

/**
 * Application-level 3D control center. The implementation remains engine
 * neutral and consumes the Responses and Character Performance micro-modules.
 */
export default function Athena3DCenter() {
  return <CharacterPerformanceLab />;
}
