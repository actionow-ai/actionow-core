import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/components/buttons/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/components/animate/tooltip';
import { toggleLanguage } from '@/lib/i18n';

function LanguageButton() {
  const { t } = useTranslation();
  const label = t('common.language');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={toggleLanguage}>
          <Languages />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export { LanguageButton };
