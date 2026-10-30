import mascotIcon from './xuanwu-mascot-icon.png';

interface XuanwuMascotIconProps {
  className?: string;
  innerClassName?: string;
  imageClassName?: string;
  variant?: 'badge' | 'plain';
}

export function XuanwuMascotIcon({
  className = '',
  innerClassName = '',
  imageClassName = '',
  variant = 'badge',
}: XuanwuMascotIconProps) {
  if (variant === 'plain') {
    return (
      <img
        src={mascotIcon}
        alt="玄武"
        className={`object-contain ${className} ${imageClassName}`}
        draggable={false}
      />
    );
  }

  return (
    <div className={`inline-flex items-center justify-center rounded-xl bg-slate-950 p-1 shadow-sm ring-1 ring-black/10 ${className}`}>
      <div className={`flex h-full w-full items-center justify-center rounded-lg bg-emerald-50 ${innerClassName}`}>
        <img
          src={mascotIcon}
          alt="玄武"
          className={`h-[88%] w-[88%] object-contain ${imageClassName}`}
          draggable={false}
        />
      </div>
    </div>
  );
}
