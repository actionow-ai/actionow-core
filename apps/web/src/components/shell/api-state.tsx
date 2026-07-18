import { AlertTriangle, ServerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/components/buttons/button';
import { RefreshCwIcon } from '@/components/ui/icons/refresh-cw';
import { Card, Skeleton } from '@/components/ui/data-display';
import { cn } from '@/lib/utils';

// 与后端契约解耦的错误形状：任何 API 客户端都能映射到它。
interface ApiStateError {
  status?: number;
  message: string;
  requestId?: string;
}

function ApiErrorNotice({
  error,
  onRetry,
  title,
  className,
}: {
  error: ApiStateError;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  // 约定：404 视为「后端能力未接入」而非「记录不存在」。若你的产品需要区分
  // 真实 404（资源被删），在调用侧先行分流，不要把两种语义都交给本组件。
  const unavailable = error.status === 404;
  return (
    <div className={cn('flex items-start gap-3 rounded-xl bg-danger/10 p-4 text-sm', className)} role="alert">
      {unavailable ? <ServerOff className="mt-0.5 size-4 text-danger" /> : <AlertTriangle className="mt-0.5 size-4 text-danger" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title ?? (unavailable ? t('apiState.unavailableTitle') : t('apiState.failedTitle'))}</p>
        <p className="mt-1 leading-relaxed text-muted-foreground">{unavailable ? t('apiState.unavailableDescription') : error.message}</p>
        {error.requestId ? (
          <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{t('apiState.requestId', { id: error.requestId })}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon animateOnHover />
          {t('apiState.retry')}
        </Button>
      ) : null}
    </div>
  );
}

function ResourceLoading({ rows = 3, className }: { rows?: number; className?: string }) {
  const { t } = useTranslation();
  return (
    <Card className={cn('grid gap-4 p-5', className)} aria-label={t('apiState.loading')}>
      <Skeleton className="h-5 w-36" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </Card>
  );
}

export { ApiErrorNotice, ResourceLoading, type ApiStateError };
