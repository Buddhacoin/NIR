-- Uses each allowed axiom so that their exact declarations can be pinned.
theorem usesAll (p : Prop) : p ∨ ¬p := Classical.em p
