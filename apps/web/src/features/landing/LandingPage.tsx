import { AppBackground } from '../../components/glass/AppBackground';
import { CTASection } from '../../components/landing/CTASection';
import { Features } from '../../components/landing/Features';
import { Footer } from '../../components/landing/Footer';
import { HeroBento } from '../../components/landing/HeroBento';
import { HowItWorks } from '../../components/landing/HowItWorks';
import { Nav } from '../../components/landing/Nav';
import { Pricing } from '../../components/landing/Pricing';

export function LandingPage() {
  return (
    <>
      <AppBackground grid />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <Nav />
        <main>
          <HeroBento />
          <Features />
          <HowItWorks />
          <Pricing />
          <CTASection />
        </main>
        <Footer />
      </div>
    </>
  );
}
