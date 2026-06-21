import { AppBackground } from '../../components/glass/AppBackground';
import { CTASection } from '../../components/landing/CTASection';
import { FeaturePan } from '../../components/landing/FeaturePan';
import { Footer } from '../../components/landing/Footer';
import { HowItWorks } from '../../components/landing/HowItWorks';
import { ImmersiveHero } from '../../components/landing/ImmersiveHero';
import { LiveConsole } from '../../components/landing/LiveConsole';
import { Nav } from '../../components/landing/Nav';
import { Pricing } from '../../components/landing/Pricing';
import { Scenarios } from '../../components/landing/Scenarios';

export function LandingPage() {
  return (
    <>
      <AppBackground grid />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <Nav />
        <main>
          <ImmersiveHero />
          <LiveConsole />
          <Scenarios />
          <FeaturePan />
          <HowItWorks />
          <Pricing />
          <CTASection />
        </main>
        <Footer />
      </div>
    </>
  );
}
