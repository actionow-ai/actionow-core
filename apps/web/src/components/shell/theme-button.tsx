import { useTranslation } from 'react-i18next';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/components/animate/tooltip';
import { Button } from '@/components/ui/components/buttons/button';
import { MoonIcon } from '@/components/ui/icons/moon';
import { SunIcon } from '@/components/ui/icons/sun';
import { useTheme } from '@/lib/theme';

function ThemeButton() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();
  const label = theme === 'dark' ? t('common.themeToLight') : t('common.themeToDark');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={toggleTheme}>
          {theme === 'dark' ? <SunIcon animateOnHover /> : <MoonIcon animateOnHover />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export { ThemeButton };
