import PostgreSQLLogo from "./icons/postgresql.png";
import MySQLLogo from "./icons/mysql.png";
import MSSQLLogo from "./icons/mssql.png";
import { PencilSimple, X } from "@phosphor-icons/react";
import { useModal } from "@/hooks/useModal";
import EditSQLConnection from "./SQLConnectionModal";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";

export const DB_LOGOS = {
  postgresql: PostgreSQLLogo,
  mysql: MySQLLogo,
  "sql-server": MSSQLLogo,
};

export default function DBConnection({
  connection,
  onRemove,
  onUpdate,
  setHasChanges,
  connections = [],
}) {
  const { database_id, engine } = connection;
  const { isOpen, openModal, closeModal } = useModal();

  async function removeConfirmation() {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "删除 SQL 连接？",
        description: `将从可用 SQL 连接列表中删除 ${database_id}。此操作无法撤销。`,
        confirmText: "删除",
      }))
    )
      return false;
    onRemove(database_id);
  }

  return (
    <div className="flex gap-x-4 items-center">
      <img
        src={DB_LOGOS?.[engine] ?? null}
        alt={`${engine} logo`}
        className="w-10 h-10 rounded-md"
      />
      <div className="flex w-full items-center justify-between">
        <div className="flex flex-col">
          <div className="text-sm font-semibold text-white">{database_id}</div>
          <div className="mt-1 text-xs text-description">{engine}</div>
        </div>
        <div className="flex gap-x-2">
          <button
            type="button"
            data-tooltip-id="edit-sql-connection-tooltip"
            className="border-none text-theme-text-secondary hover:text-theme-text-primary motion-hover p-1 rounded"
            onClick={openModal}
          >
            <PencilSimple size={18} />
          </button>
          <button
            type="button"
            data-tooltip-id="delete-sql-connection-tooltip"
            onClick={removeConfirmation}
            className="border-none text-theme-text-secondary hover:text-red-500"
          >
            <X size={18} />
          </button>
        </div>
      </div>
      <EditSQLConnection
        isOpen={isOpen}
        closeModal={closeModal}
        existingConnection={connection}
        onSubmit={onUpdate}
        setHasChanges={setHasChanges}
        connections={connections}
      />
    </div>
  );
}
