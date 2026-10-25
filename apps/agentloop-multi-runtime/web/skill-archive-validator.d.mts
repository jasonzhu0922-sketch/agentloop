export declare const SKILL_ARCHIVE_LIMITS: Readonly<Record<string, number>>;
export declare function isMacMetadataPath(value: string): boolean;
export declare function safeArchivePath(value: string): string;
export declare function validateSkillArchive(content: Buffer, options?: {
  readonly originalName?: string;
  readonly allowPrivateFiles?: boolean;
  readonly limits?: Readonly<Record<string, number>>;
}): Promise<{
  readonly entries: readonly {
    readonly path: string;
    readonly sourcePath: string;
    readonly data: Buffer;
  }[];
  readonly totalBytes: number;
}>;
