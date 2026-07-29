namespace ParentRepo10Loc;

/// <summary>
/// Provides the parent repository's pure arithmetic logic.
/// </summary>
/// <remarks>
/// The type is declared <see langword="static"/> because it holds no state and is never
/// instantiated. Keeping the calculation here, separate from the executable's entry point,
/// makes it a side-effect-free unit that the test project can assert against directly.
/// The arithmetic is intentionally frozen: the method performs the addition and nothing
/// else, so the program's observable output is preserved exactly.
/// </remarks>
public static class Calculator
{
    /// <summary>
    /// Adds two 32-bit signed integers and returns their sum.
    /// </summary>
    /// <param name="a">The first addend.</param>
    /// <param name="b">The second addend.</param>
    /// <returns>The sum of <paramref name="a"/> and <paramref name="b"/>.</returns>
    public static int Add(int a, int b) => a + b;
}
