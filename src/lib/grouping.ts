import { createContext, useContext } from 'react'
import { ARTIST_GROUPING } from '../data/grouping'

/** The shared view dimension, kept out of the raw listening history. */
export const GroupingContext = createContext(ARTIST_GROUPING)
export function useGrouping() { return useContext(GroupingContext) }
