namespace ParentRepo10Loc.Tests;

public class CalculatorTests
{
    [Fact]
    public void Add_FiveAndSeven_ReturnsTwelve()
    {
        int result = Calculator.Add(5, 7);

        Assert.Equal(12, result);
    }
}
