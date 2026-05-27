type Props = { value: boolean; onChange: (v: boolean) => void };

export default function ToggleSwitch({ value, onChange }: Props) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        value ? "bg-primary" : "bg-gray-300"
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
        value ? "translate-x-6" : "translate-x-1"
      }`} />
    </button>
  );
}
