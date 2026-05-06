interface RiskScoreProps {
  score: number;
  neutral?: boolean;
}

function colorFor(score: number, neutral?: boolean): string {
  if (neutral) return '#52525b';
  if (score >= 85) return '#22c55e';
  if (score >= 41) return '#eab308';
  return '#ef4444';
}

function labelFor(score: number, neutral?: boolean): string {
  if (neutral) return 'Idle';
  if (score >= 85) return 'Safe';
  if (score >= 41) return 'Review';
  return 'Risky';
}

export function RiskScore({ score, neutral }: RiskScoreProps) {
  const color = colorFor(score, neutral);
  const label = labelFor(score, neutral);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '16px 12px',
      }}
    >
      <div
        aria-label={`Risk score ${score} out of 100`}
        style={{
          width: 96,
          height: 96,
          borderRadius: '50%',
          border: `4px solid ${color}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 32,
          fontWeight: 700,
          color,
        }}
      >
        {score}
      </div>
      <div style={{ fontSize: 12, color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
        {label}
      </div>
    </div>
  );
}
