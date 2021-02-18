import { Unreads } from "@codestream/protocols/agent";

export interface UnreadsState extends Unreads {}

export enum UnreadsActionsType {
	Update = "@umis/Update",
	ResetLastReads = "@umis/ResetLastReads",
	ResetLastReadItems = "@umis/ResetLastReadItems"
}
