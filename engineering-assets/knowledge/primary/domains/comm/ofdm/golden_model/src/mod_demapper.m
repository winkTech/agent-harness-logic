function bits = mod_demapper(symbols, mod_type)
%% 解调映射 (软判决)
%  输入: symbols  - 接收符号 [N x 1]
%        mod_type - 'BPSK'|'QPSK'|'16QAM'|'64QAM'
%  输出: bits - 解调比特

    switch mod_type
        case 'BPSK'
            bits = real(symbols) >= 0;

        case 'QPSK'
            I = real(symbols);
            Q = imag(symbols);
            bits = zeros(2*length(symbols), 1);
            bits(1:2:end) = I >= 0;
            bits(2:2:end) = Q >= 0;

        case '16QAM'
            scale = sqrt(10);
            s = symbols * scale;
            I = real(s);
            Q = imag(s);
            N = length(symbols);
            bits = zeros(4*N, 1);
            bits(1:4:end) = I >= 0;           % b0
            bits(2:4:end) = abs(I) <= 2;       % b1 (简化判决)
            bits(3:4:end) = Q >= 0;           % b2
            bits(4:4:end) = abs(Q) <= 2;       % b3

        case '64QAM'
            scale = sqrt(42);
            s = symbols * scale;
            I = real(s);
            Q = imag(s);
            N = length(symbols);
            bits = zeros(6*N, 1);
            bits(1:6:end) = I >= 0;
            bits(2:6:end) = abs(I) <= 4;
            bits(3:6:end) = abs(abs(I)-4) <= 2;
            bits(4:6:end) = Q >= 0;
            bits(5:6:end) = abs(Q) <= 4;
            bits(6:6:end) = abs(abs(Q)-4) <= 2;

        otherwise
            error('不支持的调制方式: %s', mod_type);
    end
    bits = double(bits(:));
end
