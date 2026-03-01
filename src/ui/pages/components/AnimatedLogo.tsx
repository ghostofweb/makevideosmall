
interface AnimatedLogoProps {
  className?: string;
}

export function AnimatedLogo({ className = "w-12 h-12" }: AnimatedLogoProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <style>
        {`
          .logo-box {
            stroke-dasharray: 120;
            stroke-dashoffset: 120;
            /* transform-box is crucial so each square scales from its own center */
            transform-box: fill-box;
            transform-origin: center;
            fill: currentColor;
            fill-opacity: 0;
            animation: compressFlow 3.5s cubic-bezier(0.65, 0, 0.35, 1) infinite;
          }

          /* Tighter stagger for a fluid chain reaction */
          .box-1 { animation-delay: 0s; }
          .box-2 { animation-delay: 0.15s; }
          .box-3 { animation-delay: 0.3s; }

          @keyframes compressFlow {
            0% {
              stroke-dashoffset: 120;
              fill-opacity: 0;
              transform: scale(1);
              stroke-opacity: 0;
            }
            10% {
              stroke-opacity: 1;
            }
            35% {
              stroke-dashoffset: 0;
              fill-opacity: 0;
              transform: scale(1);
            }
            50% {
              /* The "Compression" peak: scales down and gets a faint tint */
              fill-opacity: 0.15;
              transform: scale(0.85); 
            }
            65% {
              stroke-dashoffset: 0;
              fill-opacity: 0;
              transform: scale(1);
            }
            90% {
              stroke-opacity: 1;
            }
            100% {
              stroke-dashoffset: -120;
              fill-opacity: 0;
              transform: scale(1);
              stroke-opacity: 0;
            }
          }
        `}
      </style>
      {/* Bottom Left Square */}
      <rect 
        className="logo-box box-1 text-foreground" 
        x="18" y="44" width="30" height="30" 
        stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
      />
      {/* Bottom Right Square */}
      <rect 
        className="logo-box box-2 text-foreground" 
        x="52" y="44" width="30" height="30" 
        stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
      />
      {/* Top Center Square */}
      <rect 
        className="logo-box box-3 text-foreground" 
        x="35" y="22" width="30" height="30" 
        stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
      />
    </svg>
  );
}