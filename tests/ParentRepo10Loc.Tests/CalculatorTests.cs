namespace ParentRepo10Loc.Tests;

// Locks the two-operand addition contract, so the migration's behaviour-preservation
// promise is enforced by the build instead of merely being claimed in documentation.
//
// No import directive appears anywhere in this file, and none is needed: `Calculator` is
// declared in the enclosing `ParentRepo10Loc` namespace, so outward namespace lookup
// resolves the unqualified type name below, and the xUnit namespace is contributed by the
// test project itself. Anything added here would therefore be strictly redundant, which is
// why the file declares nothing and still builds clean under the inherited
// EnforceCodeStyleInBuild and TreatWarningsAsErrors analysis gate.
public class CalculatorTests
{
    [Fact]
    public void Add_FiveAndSeven_ReturnsTwelve()
    {
        // Exercise the pure function with the two literal operands taken from the
        // original single call site, which fully determine the contract.
        int result = Calculator.Add(5, 7);

        // Assert a known-good constant rather than recomputing the sum: a recomputed
        // expectation would restate the implementation and could never fail.
        Assert.Equal(12, result);
    }
}
