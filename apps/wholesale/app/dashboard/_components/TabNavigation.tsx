type TabItem = { key: string; label: string; badge?: number };
type Props = { tabs: TabItem[]; active: string; onChange: (key: string) => void };

export default function TabNavigation({ tabs, active, onChange }: Props) {
  return (
    <div className="flex border-b border-gray-200 mb-6">
      {tabs.map(tab => (
        <button key={tab.key} onClick={() => onChange(tab.key)}
          className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 -mb-px ${
            active === tab.key
              ? "border-primary text-primary"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}>
          {tab.label}
          {(tab.badge ?? 0) > 0 && (
            <span className="bg-orange-500 text-white text-xs px-1.5 py-0.5 rounded-full">{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
