export default function LLMItem({
  name,
  value,
  image,
  description,
  checked,
  onClick,
}) {
  return (
    <div
      onClick={() => onClick(value)}
      className={`settings-soft-provider-option ${
        checked ? "is-selected" : ""
      }`}
    >
      <div className="settings-soft-provider-copy">
        <span className="settings-soft-provider-logo-wrap">
          <img
            src={image}
            alt={`${name} logo`}
            className="settings-soft-provider-logo"
          />
        </span>
        <div className="min-w-0 flex flex-col">
          <div className="settings-soft-provider-name">{name}</div>
          <div className="settings-soft-provider-description">
            {description}
          </div>
        </div>
      </div>
    </div>
  );
}
