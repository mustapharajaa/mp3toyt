
import React from 'react';

interface PricingToggleProps {
  active: 'monthly' | 'yearly';
  onChange: (value: 'monthly' | 'yearly') => void;
}

export const PricingToggle: React.FC<PricingToggleProps> = ({ active, onChange }) => {
  return (
    <div className="bg-[#121212] p-1.5 rounded-full flex items-center w-[360px] h-16 relative border border-white/5 shadow-inner">
      {/* Active Indicator (The Pill) */}
      <div 
        className={`absolute h-[calc(100%-12px)] w-[calc(50%-6px)] bg-white rounded-full transition-all duration-300 ease-in-out z-0 ${
          active === 'monthly' ? 'translate-x-0' : 'translate-x-[calc(100%)]'
        }`}
      />
      
      {/* Buttons */}
      <button
        onClick={() => onChange('monthly')}
        className={`relative flex-1 text-lg font-semibold transition-colors duration-300 z-10 ${
          active === 'monthly' ? 'text-black' : 'text-gray-500 hover:text-gray-300'
        }`}
      >
        Monthly
      </button>
      <button
        onClick={() => onChange('yearly')}
        className={`relative flex-1 text-lg font-semibold transition-colors duration-300 z-10 ${
          active === 'yearly' ? 'text-black' : 'text-gray-500 hover:text-gray-300'
        }`}
      >
        Yearly
      </button>
    </div>
  );
};
