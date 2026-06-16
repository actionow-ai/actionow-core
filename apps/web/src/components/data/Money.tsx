import { useTranslation } from 'react-i18next';

import { formatCredits } from '../../lib/money';

export function Money({ micro }: { micro: string }) {
  const { i18n } = useTranslation();
  return <span className="tabular">{formatCredits(micro, i18n.language)}</span>;
}
