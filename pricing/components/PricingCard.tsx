
import React from 'react';

interface PricingCardProps {
  type: 'free' | 'pro';
  title: string;
  subtitle: string;
  price: number;
  billingCycle: 'monthly' | 'yearly';
  buttonText: string;
  features: string[];
  icon: string;
  isFeatured?: boolean;
  extraHighlight?: string;
}

export const PricingCard: React.FC<PricingCardProps> = ({
  type,
  title,
  subtitle,
  price,
  billingCycle,
  buttonText,
  features,
  icon,
  isFeatured = false,
  extraHighlight
}) => {
  return (
    <div className={`relative p-8 md:p-10 rounded-[40px] flex flex-col transition-all duration-300 border ${
      isFeatured 
        ? 'bg-[#121212] border-white/10 shadow-[0_20px_60px_rgba(0,0,0,0.6)]' 
        : 'bg-[#0f0f0f] border-white/5'
    }`}>
      {/* Top Icon Badge - with better cutout visual */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center text-3xl shadow-xl border ${
          isFeatured ? 'bg-[#1a1a1a] border-white/20 text-blue-400' : 'bg-[#1a1a1a] border-white/10 text-gray-400'
        }`}>
          {icon}
        </div>
      </div>

      {/* PRO Label SVG-style tag */}
      {isFeatured && (
        <div className="absolute top-8 right-10">
          <div className="bg-[#1a1a1a] border border-white/10 text-[10px] font-bold tracking-widest px-2.5 py-1 rounded text-gray-400 uppercase">
            Pro
          </div>
        </div>
      )}

      {/* Card Content */}
      <div className="mt-10 text-center flex-grow flex flex-col">
        <h2 className={`text-4xl font-bold mb-3 ${isFeatured ? 'text-white' : 'text-gray-100'}`}>
          {title}
        </h2>
        <p className="text-gray-500 mb-8 text-sm md:text-base leading-relaxed">
          {subtitle}
        </p>

        {/* CTA Button */}
        <button className={`w-full py-4.5 px-6 rounded-full font-bold text-lg mb-8 transition-all active:scale-[0.98] ${
          isFeatured 
            ? 'bg-white text-black hover:bg-gray-200' 
            : 'bg-[#1a1a1a] border border-white/10 hover:bg-[#252525] text-white'
        }`}>
          {buttonText}
        </button>

        <div className="w-full h-px bg-white/5 mb-8" />

        {/* Features List */}
        <ul className="space-y-4 text-left flex-grow">
          {features.map((feature, idx) => (
            <li key={idx} className="flex items-start gap-3 group">
              <div className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                isFeatured ? 'bg-blue-900/40' : 'bg-gray-800'
              }`}>
                <svg className={`w-3 h-3 ${isFeatured ? 'text-blue-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-gray-400 text-[15px] leading-snug group-hover:text-gray-300 transition-colors">
                {feature}
              </span>
            </li>
          ))}
          
          {extraHighlight && (
            <li className="flex items-center gap-3 pt-2">
              <span className="w-5 h-5 flex items-center justify-center text-blue-500 font-bold text-lg">
                +
              </span>
              <span className="text-blue-500/90 text-[15px] font-medium leading-snug">
                {extraHighlight}
              </span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
};
