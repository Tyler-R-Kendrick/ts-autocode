// Generated from an ambient trainable declaration — do not edit by hand.
import { defineGrounding } from "ts-autocode/grounding";

export const greet = defineGrounding({
	"methodRef": "Program.greet",
	"intent": "Produce a greeting",
	"contract": {
		"ref": "decl://Program.greet",
		"input": {
			"name": {
				"type": "string",
				"optional": true,
				"description": "Optional person to greet"
			}
		},
		"output": {
			"type": "string",
			"description": "Hello World! or Hello, <name>!"
		}
	},
	"params": {
		"name": {
			"description": "Optional person to greet"
		}
	},
	"output": {
		"returns": {
			"description": "Hello World! or Hello, <name>!"
		}
	}
});

export const other = defineGrounding({
	"methodRef": "Program.other",
	"intent": "Inferred: implement Program.other to satisfy its declared signature and descriptions.",
	"contract": {
		"ref": "decl://Program.other",
		"input": {
			"count": {
				"type": "number",
				"optional": false
			}
		},
		"output": {
			"type": "number"
		}
	}
});
