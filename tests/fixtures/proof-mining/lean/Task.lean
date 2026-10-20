-- The task: one definition `NIR.statement : Prop` and its dependencies.
def NIR.statement : Prop := ∀ n : Nat, Nat.add n Nat.zero = n
