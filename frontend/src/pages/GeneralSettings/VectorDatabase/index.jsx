import React, { useState, useEffect, useRef } from "react";
import System from "@/models/system";
import showToast from "@/utils/toast";
import { useModal } from "@/hooks/useModal";
import { CaretUpDown, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import ChangeWarningModal from "@/components/ChangeWarning";
import ModalWrapper from "@/components/ModalWrapper";
import VectorDBItem from "@/components/VectorDBSelection/VectorDBItem";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";
import {
  SoftButton,
  SoftCard,
  SoftProviderDropdown,
  SoftProviderTrigger,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

import LanceDbLogo from "@/media/vectordbs/lancedb.png";
import ChromaLogo from "@/media/vectordbs/chroma.png";
import PineconeLogo from "@/media/vectordbs/pinecone.png";
import WeaviateLogo from "@/media/vectordbs/weaviate.png";
import QDrantLogo from "@/media/vectordbs/qdrant.png";
import MilvusLogo from "@/media/vectordbs/milvus.png";
import ZillizLogo from "@/media/vectordbs/zilliz.png";
import AstraDBLogo from "@/media/vectordbs/astraDB.png";
import PGVectorLogo from "@/media/vectordbs/pgvector.png";

import LanceDBOptions from "@/components/VectorDBSelection/LanceDBOptions";
import ChromaDBOptions from "@/components/VectorDBSelection/ChromaDBOptions";
import ChromaCloudOptions from "@/components/VectorDBSelection/ChromaCloudOptions";
import PineconeDBOptions from "@/components/VectorDBSelection/PineconeDBOptions";
import WeaviateDBOptions from "@/components/VectorDBSelection/WeaviateDBOptions";
import QDrantDBOptions from "@/components/VectorDBSelection/QDrantDBOptions";
import MilvusDBOptions from "@/components/VectorDBSelection/MilvusDBOptions";
import ZillizCloudOptions from "@/components/VectorDBSelection/ZillizCloudOptions";
import AstraDBOptions from "@/components/VectorDBSelection/AstraDBOptions";
import PGVectorOptions from "@/components/VectorDBSelection/PGVectorOptions";

const VECTOR_DBS = [
  {
    name: "LanceDB",
    value: "lancedb",
    logo: LanceDbLogo,
    options: (_) => <LanceDBOptions />,
    description:
      "Local storage for Athena Vector Engine, running on this instance.",
  },
  {
    name: "PGVector",
    value: "pgvector",
    logo: PGVectorLogo,
    options: (settings) => <PGVectorOptions settings={settings} />,
    description: "Vector search powered by PostgreSQL.",
  },
  {
    name: "Chroma",
    value: "chroma",
    logo: ChromaLogo,
    options: (settings) => <ChromaDBOptions settings={settings} />,
    description:
      "Open source vector database you can host yourself or on the cloud.",
  },
  {
    name: "Chroma Cloud",
    value: "chromacloud",
    logo: ChromaLogo,
    options: (settings) => <ChromaCloudOptions settings={settings} />,
    description:
      "Fully managed Chroma cloud service with enterprise features and support.",
  },
  {
    name: "Pinecone",
    value: "pinecone",
    logo: PineconeLogo,
    options: (settings) => <PineconeDBOptions settings={settings} />,
    description: "100% cloud-based vector database for enterprise use cases.",
  },
  {
    name: "Zilliz Cloud",
    value: "zilliz",
    logo: ZillizLogo,
    options: (settings) => <ZillizCloudOptions settings={settings} />,
    description:
      "Cloud hosted vector database built for enterprise with SOC 2 compliance.",
  },
  {
    name: "QDrant",
    value: "qdrant",
    logo: QDrantLogo,
    options: (settings) => <QDrantDBOptions settings={settings} />,
    description: "Open source local and distributed cloud vector database.",
  },
  {
    name: "Weaviate",
    value: "weaviate",
    logo: WeaviateLogo,
    options: (settings) => <WeaviateDBOptions settings={settings} />,
    description:
      "Open source local and cloud hosted multi-modal vector database.",
  },
  {
    name: "Milvus",
    value: "milvus",
    logo: MilvusLogo,
    options: (settings) => <MilvusDBOptions settings={settings} />,
    description: "Open-source, highly scalable, and blazing fast.",
  },
  {
    name: "AstraDB",
    value: "astra",
    logo: AstraDBLogo,
    options: (settings) => <AstraDBOptions settings={settings} />,
    description: "Vector Search for Real-world GenAI.",
  },
];

export default function GeneralVectorDatabase() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [hasEmbeddings, setHasEmbeddings] = useState(false);
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredVDBs, setFilteredVDBs] = useState([]);
  const [selectedVDB, setSelectedVDB] = useState(null);
  const [searchMenuOpen, setSearchMenuOpen] = useState(false);
  const searchInputRef = useRef(null);
  const { isOpen, openModal, closeModal } = useModal();
  const { t } = useTranslation();
  const loadSettingsSection = useSettingsSection("vector");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (selectedVDB !== settings?.VectorDB && hasChanges && hasEmbeddings) {
      openModal();
    } else {
      await handleSaveSettings();
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    const form = document.getElementById("vectordb-form");
    const settingsData = {};
    const formData = new FormData(form);
    settingsData.VectorDB = selectedVDB;
    for (var [key, value] of formData.entries()) settingsData[key] = value;

    const { error } = await System.updateSystem(settingsData);
    if (error) {
      showToast(`Failed to save vector database settings: ${error}`, "error");
      setHasChanges(true);
    } else {
      showToast("Vector database preferences saved successfully.", "success");
      setHasChanges(false);
    }
    setSaving(false);
    closeModal();
  };

  const updateVectorChoice = (selection) => {
    setSearchQuery("");
    setSelectedVDB(selection);
    setSearchMenuOpen(false);
    setHasChanges(true);
  };

  const handleXButton = () => {
    if (searchQuery.length > 0) {
      setSearchQuery("");
      if (searchInputRef.current) searchInputRef.current.value = "";
    } else {
      setSearchMenuOpen(!searchMenuOpen);
    }
  };

  useEffect(() => {
    async function fetchKeys() {
      const _settings = await loadSettingsSection();
      setSettings(_settings);
      setSelectedVDB(_settings?.VectorDB || "lancedb");
      setHasEmbeddings(_settings?.HasExistingEmbeddings || false);
      setLoading(false);
    }
    fetchKeys();
  }, [loadSettingsSection]);

  useEffect(() => {
    const filtered = VECTOR_DBS.filter((vdb) =>
      vdb.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    setFilteredVDBs(filtered);
  }, [searchQuery, selectedVDB]);

  const selectedVDBObject =
    VECTOR_DBS.find((vdb) => vdb.value === selectedVDB) ?? VECTOR_DBS[0];

  return (
    <SoftSettingsLayout
      title={t("vector.title")}
      description={t("vector.description")}
      actions={
        hasChanges && (
          <SoftButton type="submit" form="vectordb-form">
            {saving ? t("common.saving") : t("common.save")}
          </SoftButton>
        )
      }
    >
      {loading ? (
        <SoftCard>
          <div className="flex w-full max-w-[720px] flex-col gap-y-4">
            <div className="motion-skeleton h-16 rounded-2xl" />
            <div className="motion-skeleton h-28 rounded-2xl" />
            <div className="motion-skeleton h-10 w-2/3 rounded-2xl" />
          </div>
        </SoftCard>
      ) : (
        <form
          id="vectordb-form"
          onSubmit={handleSubmit}
          className="settings-soft-form"
        >
          <SoftCard title={t("vector.provider.title")}>
            <div className="settings-soft-provider-picker">
              <SoftProviderTrigger
                logo={selectedVDBObject.logo}
                name={selectedVDBObject.name}
                description={selectedVDBObject.description}
                onClick={() => setSearchMenuOpen((open) => !open)}
              >
                <CaretUpDown
                  size={24}
                  weight="bold"
                  className="text-[var(--soft-text-muted)]"
                />
              </SoftProviderTrigger>
              <SoftProviderDropdown open={searchMenuOpen}>
                <div className="settings-soft-provider-searchbar">
                  <MagnifyingGlass
                    size={20}
                    weight="bold"
                    className="text-[var(--soft-text-muted)]"
                  />
                  <input
                    type="text"
                    name="vdb-search"
                    autoComplete="off"
                    placeholder="Search all vector database providers"
                    onChange={(e) => setSearchQuery(e.target.value)}
                    ref={searchInputRef}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.preventDefault();
                    }}
                  />
                  <X
                    size={20}
                    weight="bold"
                    className="cursor-pointer text-[var(--soft-text-muted)] hover:text-[var(--soft-text-primary)]"
                    onClick={handleXButton}
                  />
                </div>
                <div className="settings-soft-provider-list white-scrollbar">
                  {filteredVDBs.map((vdb) => (
                    <VectorDBItem
                      key={vdb.name}
                      name={vdb.name}
                      value={vdb.value}
                      image={vdb.logo}
                      description={vdb.description}
                      checked={selectedVDB === vdb.value}
                      onClick={() => updateVectorChoice(vdb.value)}
                    />
                  ))}
                </div>
              </SoftProviderDropdown>
            </div>
            <div
              onChange={() => setHasChanges(true)}
              className="mt-5 flex flex-col gap-y-1"
            >
              {selectedVDB &&
                VECTOR_DBS.find((vdb) => vdb.value === selectedVDB)?.options(
                  settings
                )}
            </div>
          </SoftCard>
        </form>
      )}
      <ModalWrapper isOpen={isOpen}>
        <ChangeWarningModal
          warningText="Switching the vector database will reset all previously embedded documents in all workspaces.\n\nConfirming will clear all embeddings from your vector database and remove all documents from your workspaces. Your uploaded documents will not be deleted, they will be available for re-embedding."
          onClose={closeModal}
          onConfirm={handleSaveSettings}
        />
      </ModalWrapper>
    </SoftSettingsLayout>
  );
}
