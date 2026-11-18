import { monotonicFactory } from "ulid";

/**
 * Monotonic ULIDs: ids generated later in this process always sort higher,
 * even within the same millisecond. Code relies on this to order runs and
 * decisions ("was this decision made after that run started?").
 */
export const newId = monotonicFactory();
