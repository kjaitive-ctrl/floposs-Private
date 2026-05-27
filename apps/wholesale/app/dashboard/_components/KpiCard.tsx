type Props = {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
};

export default function KpiCard({ label, value, sub, valueColor = "text-gray-900" }: Props) {
  return (
    <div className="bg-gray-50 rounded-xl border border-gray-200 px-4 py-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-lg font-bold ${valueColor}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  );
}
