using ParentRepo10Loc;

// Entry point of the ParentRepo10Loc console application.
//
// The program is expressed as top-level statements, which is the C# form of a script-style
// module: the compiler synthesizes the entry point, and the statements below execute only
// when this assembly is the one being launched. That guarantee is delivered structurally by
// the project system, so no runtime guard is written here.
//
// Responsibilities are split deliberately. Every emission lives in this file, while the
// arithmetic lives in Calculator, a side-effect-free static type the test project asserts
// against on its own. The directive above is required precisely because that type sits in a
// named scope whereas top-level statements sit in the global one.
//
// The observable contract of this file is the acceptance oracle for the whole repository and
// is compared byte-for-byte against a recorded digest during continuous integration: the
// value 12 on five separate lines, each terminated by a single line feed, totalling 15 bytes,
// with an implicit exit code of 0.

// Both operands are frozen literals, so the sum is a fixed value computed once and reused.
// A mutable local is used rather than a compile-time constant because the initializer is a
// method call, and a method call cannot be evaluated by the compiler.
int result = Calculator.Add(5, 7);

// The emission count is carried as an explicit numeric bound instead of repeated statements,
// which keeps "five lines of output" a single, reviewable fact rather than duplicated text.
// The integer is handed to the console unconverted: an explicit string conversion would
// require a format provider to satisfy the analyzer gate while changing nothing about the
// bytes produced, since this value renders the same way under every culture.
for (int i = 0; i < 5; i++)
{
    Console.WriteLine(result);
}
