
import React, { useState } from 'react';
import { PricingCard } from './components/PricingCard';
import { PricingToggle } from './components/PricingToggle';

const App: React.FC = () => {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('yearly');

  return (
    <div className="min-h-screen bg-wavy text-white flex flex-col items-center py-24 px-4 overflow-x-hidden">
      {/* Header Section */}
      <div className="text-center mb-16 relative w-full max-w-3xl px-4 flex flex-col items-center">
        <h1 className="text-4xl md:text-6xl font-bold mb-4 tracking-tight">Simple pricing, no surprises</h1>
        <p className="text-gray-400 text-lg md:text-xl font-medium opacity-80">Start free. Pay only if you love it.</p>
        
        <div className="mt-12 relative">
          <PricingToggle 
            active={billingCycle} 
            onChange={(val) => setBillingCycle(val)} 
          />
          
          {/* 33% off handwritten callout and arrow - calibrated to match the image */}
          <div className="absolute left-[calc(100%-15px)] top-[-5px] hidden md:block w-48 h-24 pointer-events-none">
            <div className="relative w-full h-full">
              {/* Arrow SVG - Refined to match the user's image loopy hand-drawn style */}
              <svg 
                className="absolute left-0 top-0 w-28 h-12 text-gray-500/70" 
                viewBox="0 0 120 50" 
                fill="none" 
                xmlns="http://www.w3.org/2000/svg"
              >
                <path 
                  d="M110 40 C 100 20, 60 5, 15 15" 
                  stroke="currentColor" 
                  strokeWidth="1.8" 
                  strokeLinecap="round" 
                  fill="none"
                />
                {/* Arrowhead */}
                <path 
                  d="M25 8 L 12 16 L 24 22" 
                  stroke="currentColor" 
                  strokeWidth="1.8" 
                  strokeLinecap="round" 
                  strokeLinejoin="round" 
                />
              </svg>
              
              {/* 33% off! text - precisely rotated and styled */}
              <div className="absolute left-20 top-10 -rotate-[15deg]">
                 <span className="font-handwritten text-4xl text-gray-400/90 whitespace-nowrap select-none tracking-wide">
                  33% off!
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Pricing Cards Container */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-6xl w-full px-4">
        {/* Free Plan */}
        <PricingCard
          type="free"
          title="Free, forever"
          subtitle="The original Chrome extension"
          price={0}
          billingCycle={billingCycle}
          buttonText="Get the free extension"
          icon="🎨"
          features={[
            "Record any tab, app, screen, or camera",
            "Annotate by drawing on any tab",
            "Blur sensitive content in tabs",
            "Highlight your clicks and cursor",
            "Videos stored locally on your device",
            "Open source, loved by many ❤️"
          ]}
        />

        {/* Pro Plan */}
        <PricingCard
          type="pro"
          title={billingCycle === 'yearly' ? "$8/mo" : "$12/mo"}
          subtitle={billingCycle === 'yearly' ? "$96 paid yearly. Cancel anytime." : "$12 paid monthly. Cancel anytime."}
          price={billingCycle === 'yearly' ? 8 : 12}
          billingCycle={billingCycle}
          buttonText="Try Pro free for 7 days"
          icon="✨"
          isFeatured
          features={[
            "100GB cloud storage, upload and manage all your videos",
            "Share videos with a link, or keep them completely private",
            "Record up to 1 hour per session",
            "15 renders/month, unlimited Instant Mode downloads",
            "Keyframes and automatic zoom on click",
            "Animated templates, captions, layouts, and more",
            "EU-based infrastructure (no US data transfer) 🇪🇺"
          ]}
          extraHighlight="+ All Chrome extension features included"
        />
      </div>
    </div>
  );
}

export default App;
