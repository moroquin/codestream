import { ActionType } from "../common";
import * as actions from "./actions";
import { UnreadsState, UnreadsActionsType } from "./types";

type UnreadsActions = ActionType<typeof actions>;

const initialState: UnreadsState = {
	lastReads: {},
	lastReadItems: {},
	mentions: {},
	unreads: {},
	totalUnreads: 0,
	totalMentions: 0
};

export function reduceUnreads(state = initialState, action: UnreadsActions) {
	switch (action.type) {
		case UnreadsActionsType.Update: {
			const { payload } = action;
			return {
				totalMentions: payload.totalMentions,
				totalUnreads: payload.totalUnreads,
				lastReads: { ...state.lastReads, ...payload.lastReads },
				lastReadItems: { ...state.lastReadItems, ...payload.lastReadItems },
				mentions: payload.mentions,
				unreads: payload.unreads
			};
		}
		case UnreadsActionsType.ResetLastReads: {
			return { ...state, lastReads: {} };
		}
		case UnreadsActionsType.ResetLastReadItems: {
			return { ...state, lastReadItems: {} };
		}
		case "RESET":
			return initialState;
		default:
			return state;
	}
}
