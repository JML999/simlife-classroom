const WHEEL_LABELS = ["Inheritance", "Tax refund", "Side gig", "Rebate", "Flat tire", "Phone repair", "Urgent care", "Parking ticket", "Career twist", "Career twist", "Credit-card debt"];
export const SPIN_DURATION = 6800;

export function WheelFace({ angle, options, presenting = false }: { angle: number; options: any[]; presenting?: boolean }) {
  const step = 360 / Math.max(1, options.length);
  const colors = ["#dfbd77", "#8d9d77", "#e7d7a5", "#b9c6a2", "#d4a994", "#9fa67d", "#ecc79f", "#a8bca6", "#d9bf89", "#c2ab9a", "#c99185"];
  const background = `conic-gradient(from ${-step / 2}deg, ${options.flatMap((_, i) => [`${colors[i % colors.length]} ${i * step}deg ${(i + 1) * step - .8}deg`, `#62654c ${(i + 1) * step - .8}deg ${(i + 1) * step}deg`]).join(", ")})`;
  return <div className={`life-wheel-wrap${presenting ? " is-presenting" : ""}`}>
    <div className="life-wheel-pointer" aria-hidden="true">▼</div>
    <div className="life-wheel" style={{ transform: `rotate(${angle}deg)`, background }} aria-hidden="true">
      {options.map((option, index) => <span className="life-wheel-option" key={option.key} style={{ transform: `translate(-50%, -50%) rotate(${index * step}deg) translateY(var(--wheel-label-offset)) rotate(${-index * step}deg)` }}>{option.shortLabel || (option.type ? WHEEL_LABELS[index] : option.title)}</span>)}
      <span className="life-wheel-hub">SIMLIFE</span>
    </div>
  </div>;
}

