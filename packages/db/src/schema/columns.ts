import { timestamp } from 'drizzle-orm/pg-core';

/** Every timestamp is `timestamptz`, read back as a JS `Date`. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
