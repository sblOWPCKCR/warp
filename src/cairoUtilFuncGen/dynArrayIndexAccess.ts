import assert = require('assert');
import {
  ArrayType,
  ASTNode,
  FunctionCall,
  getNodeType,
  IndexAccess,
  PointerType,
  TypeNode,
} from 'solc-typed-ast';
import { AST } from '../ast/ast';
import { CairoType, TypeConversionContext } from '../utils/cairoTypeSystem';
import { createCairoFunctionStub, createCallToStub } from '../utils/functionStubbing';
import { createUint256TypeName } from '../utils/nodeTemplates';
import { typeNameFromTypeNode } from '../utils/utils';
import { CairoFunction, CairoUtilFuncGenBase } from './base';
import { DynArrayGen } from './dynArray';

export class DynArrayIndexAccessGen extends CairoUtilFuncGenBase {
  constructor(private dynArrayGen: DynArrayGen, ast: AST) {
    super(ast);
  }

  private generatedFunctions: Map<string, CairoFunction> = new Map();
  getGeneratedCode(): string {
    return [...this.generatedFunctions.values()].map((func) => func.code).join('\n\n');
  }

  gen(node: IndexAccess, nodeInSourceUnit?: ASTNode): FunctionCall {
    const base = node.vBaseExpression;
    const index = node.vIndexExpression;
    assert(index !== undefined);

    const nodeType = getNodeType(node, this.ast.compilerVersion);
    const baseType = getNodeType(base, this.ast.compilerVersion);

    assert(baseType instanceof PointerType && baseType.to instanceof ArrayType);
    const name = this.getOrCreate(nodeType);

    const functionStub = createCairoFunctionStub(
      name,
      [
        ['loc', typeNameFromTypeNode(baseType, this.ast)],
        ['offset', createUint256TypeName(this.ast)],
      ],
      [['resLoc', typeNameFromTypeNode(nodeType, this.ast)]],
      ['syscall_ptr', 'pedersen_ptr', 'range_check_ptr'],
      this.ast,
      nodeInSourceUnit ?? node,
    );

    return createCallToStub(functionStub, [base, index], this.ast);
  }

  private getOrCreate(valueType: TypeNode): string {
    const valueCairoType = CairoType.fromSol(
      valueType,
      this.ast,
      TypeConversionContext.StorageAllocation,
    );
    const key = valueCairoType.fullStringRepresentation;
    const existing = this.generatedFunctions.get(key);
    if (existing !== undefined) {
      return existing.name;
    }

    const [arrayName, lengthName] = this.dynArrayGen.gen(valueCairoType);
    const funcName = `${arrayName}_IDX`;
    this.generatedFunctions.set(key, {
      name: funcName,
      code: [
        `func ${funcName}{syscall_ptr : felt*, pedersen_ptr : HashBuiltin*, range_check_ptr : felt}(ref: felt, index: Uint256) -> (res: felt):`,
        `    alloc_locals`,
        `    let (length) = ${lengthName}.read(ref)`,
        `    let (inRange) = uint256_lt(index, length)`,
        `    assert inRange = 1`,
        `    let (existing) = ${arrayName}.read(ref, index)`,
        `    if existing == 0:`,
        `        let (used) = WARP_USED_STORAGE.read()`,
        `        WARP_USED_STORAGE.write(used + ${valueCairoType.width})`,
        `        ${arrayName}.write(ref, index, used)`,
        `        return (used)`,
        `    else:`,
        `        return (existing)`,
        `    end`,
        `end`,
      ].join('\n'),
    });
    this.requireImport('starkware.cairo.common.uint256', 'Uint256');
    this.requireImport('starkware.cairo.common.uint256', 'uint256_lt');
    return funcName;
  }
}
