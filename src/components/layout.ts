/**
 * One page container for every screen: full width with gutters proportional to the
 * screen (not a fixed narrow column), so header, studio, maker and buyer pages line up.
 * Very wide monitors are capped only where lines would become unreadable.
 */
export const PAGE_X = "px-4 sm:px-6 lg:px-[4vw]";
export const PAGE = `mx-auto w-full max-w-[120rem] ${PAGE_X}`;
