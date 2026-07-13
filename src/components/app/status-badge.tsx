/**
 * @file Status badges for jobs, tasks and validation results.
 *
 * Colour alone is never the signal — each badge pairs a hue with a distinct icon and
 * a word, so the state is legible to a colour-blind user and in a greyscale
 * screenshot pasted into an incident channel.
 */

'use client';

import * as React from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CirclePause,
  Loader2,
  MinusCircle,
  XCircle,
} from 'lucide-react';
import type { JobStatus, TaskStatus, ValidationStatus } from '@/core/domain/types';
import { Badge } from '@/components/ui/primitives';

const JOB_STATUS: Record<
  JobStatus,
  { label: string; tone: 'neutral' | 'brand' | 'ok' | 'warn' | 'danger'; icon: React.ComponentType<{ className?: string }> }
> = {
  created: { label: 'Ready', tone: 'neutral', icon: CircleDashed },
  running: { label: 'Running', tone: 'brand', icon: Loader2 },
  paused: { label: 'Paused', tone: 'warn', icon: CirclePause },
  completed: { label: 'Completed', tone: 'ok', icon: CheckCircle2 },
  completed_with_errors: { label: 'Completed with errors', tone: 'warn', icon: AlertTriangle },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
};

export function StatusBadge({ status }: { status: JobStatus }): React.JSX.Element {
  const config = JOB_STATUS[status];
  const Icon = config.icon;

  return (
    <Badge tone={config.tone}>
      <Icon className={`size-3 ${status === 'running' ? 'animate-spin' : ''}`} />
      {config.label}
    </Badge>
  );
}

const TASK_STATUS: Record<
  TaskStatus,
  { label: string; tone: 'neutral' | 'brand' | 'ok' | 'warn' | 'danger'; icon: React.ComponentType<{ className?: string }> }
> = {
  pending: { label: 'Pending', tone: 'neutral', icon: CircleDashed },
  running: { label: 'Running', tone: 'brand', icon: Loader2 },
  completed: { label: 'Done', tone: 'ok', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  skipped: { label: 'Skipped', tone: 'warn', icon: MinusCircle },
};

export function TaskStatusBadge({ status }: { status: TaskStatus }): React.JSX.Element {
  const config = TASK_STATUS[status];
  const Icon = config.icon;

  return (
    <Badge tone={config.tone}>
      <Icon className={`size-3 ${status === 'running' ? 'animate-spin' : ''}`} />
      {config.label}
    </Badge>
  );
}

export function ValidationBadge({ status }: { status: ValidationStatus }): React.JSX.Element {
  const config = {
    pass: { label: 'Pass', tone: 'ok' as const, icon: CheckCircle2 },
    warn: { label: 'Warn', tone: 'warn' as const, icon: AlertTriangle },
    fail: { label: 'Fail', tone: 'danger' as const, icon: XCircle },
  }[status];
  const Icon = config.icon;

  return (
    <Badge tone={config.tone}>
      <Icon className="size-3" />
      {config.label}
    </Badge>
  );
}
