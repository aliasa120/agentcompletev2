# -*- coding: utf-8 -*-  
import os  
from reportlab.lib.pagesizes import A4  
from reportlab.lib.units import inch  
from reportlab.lib import colors  
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle  
from reportlab.lib.enums import TA_CENTER, TA_LEFT  
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak  
OUT_DIR = 'math_pdf_assets'  
styles = getSampleStyleSheet()  
title_style = ParagraphStyle('TitleX', parent=styles['Title'], fontSize=22, leading=26, alignment=TA_CENTER, textColor=colors.HexColor('#1a3a5c'))  
sub_style = ParagraphStyle('SubX', parent=styles['Normal'], fontSize=12, leading=16, alignment=TA_CENTER, textColor=colors.HexColor('#555555'))  
h2_style = ParagraphStyle('H2X', parent=styles['Heading2'], fontSize=15, leading=19, textColor=colors.HexColor('#1a3a5c'), spaceBefore=10, spaceAfter=6)  
body_style = ParagraphStyle('BodyX', parent=styles['Normal'], fontSize=10.5, leading=15, alignment=TA_LEFT)  
sol_style = ParagraphStyle('SolX', parent=styles['Normal'], fontSize=10, leading=14, leftIndent=8, textColor=colors.HexColor('#333333'))  
problems = []  
problems.append(('1. Quadratic Equations', 'Solve x2 - 4x + 3 = 0 and sketch the graph.', 'Factor: (x-1)(x-3) = 0, so x = 1 or x = 3. The parabola opens upward with vertex at x = 2, y = -1. Roots are the x-intercepts (1,0) and (3,0).', 'g1.png'))  
problems.append(('2. Linear Equations', 'Find the slope and y-intercept of y = 2x + 1, then graph it.', 'Slope m = 2, y-intercept b = 1. The line rises 2 units for every 1 unit to the right. It crosses the y-axis at (0,1).', 'g2.png'))  
problems.append(('3. Systems of Equations', 'Solve the system: y = x + 1 and y = -x + 3.', 'Set x + 1 = -x + 3, giving 2x = 2, so x = 1. Then y = 2. Solution: (1, 2). The lines intersect at this point.', 'g3.png'))  
problems.append(('4. Differentiation (Tangent)', 'Find the equation of the tangent line to y = x2 at x = 1.', 'Derivative y = 2x. At x = 1, slope = 2. Point is (1,1). Tangent: y - 1 = 2(x - 1), so y = 2x - 1.', 'g4.png'))  
problems.append(('5. Integration (Area)', 'Find the area under y = x2 from x = 0 to x = 2.', 'Integral of x2 is x3/3. Evaluate from 0 to 2: (8/3) - 0 = 8/3 square units.', 'g5.png'))  
problems.append(('6. Trigonometry', 'State the values of sin(0), cos(0), sin(pi/2), cos(pi/2).', 'sin(0) = 0, cos(0) = 1, sin(pi/2) = 1, cos(pi/2) = 0. The sine and cosine functions are periodic with period 2*pi.', 'g6.png'))  
problems.append(('7. Exponential Functions', 'Evaluate 23 and sketch y = 2x.', '23 = 8. The function y = 2x grows rapidly, passing through (0,1) and increasing without bound as x increases.', 'g7.png'))  
problems.append(('8. Logarithms', 'Solve ln(x) = 2 for x.', 'By definition, x = e2. Since e ~ 2.718, x ~ 7.389. The natural log is the inverse of the exponential.', 'g8.png'))  
problems.append(('9. Geometry (Circle)', 'Find the radius of the circle x2 + y2 = 25.', 'The equation is in standard form x2 + y2 = r2, so r2 = 25 and r = 5. Center is at the origin (0,0).', 'g9.png'))  
problems.append(('10. Pythagorean Theorem', 'A right triangle has legs 3 and 4. Find the hypotenuse.', 'By the Pythagorean theorem, c2 = 32 + 42 = 9 + 16 = 25, so c = 5. This is the classic 3-4-5 triangle.', 'g10.png'))  
problems.append(('11. Statistics (Normal Distribution)', 'For a standard normal distribution N(0,1), what is the mean and standard deviation?', 'The mean is 0 and the standard deviation is 1. The curve is symmetric and bell-shaped, with about 68% of data within 1 standard deviation.', 'g11.png'))  
problems.append(('12. Probability (Binomial)', 'A fair coin is tossed 10 times. Find the probability of exactly 5 heads.', 'Using the binomial formula P(X=k) = C(10,5)(0.5)5(0.5)5 = 252 * (0.5)10 = 252/1024 ~ 0.246.', 'g12.png'))  
problems.append(('13. Limits', 'Evaluate the limit as x approaches 0 of sin(x)/x.', 'This is a fundamental limit. As x approaches 0, sin(x)/x approaches 1. This is proven using the squeeze theorem.', 'g13.png'))  
problems.append(('14. Arithmetic Sequences', 'Find the 10th term of the sequence 3, 5, 7, 9, ...', 'The common difference is 2. The nth term is a_n = 3 + (n-1)*2 = 2n + 1. So a_10 = 2(10) + 1 = 21.', 'g14.png'))  
problems.append(('15. Geometric Series', 'Find the sum of the infinite geometric series 3 + 1.5 + 0.75 + ...', 'First term a = 3, common ratio r = 0.5. Sum = a/(1-r) = 3/(1-0.5) = 3/0.5 = 6.', 'g15.png'))  
problems.append(('16. Matrices', 'Given A = [[1,2],[3,4]], find the determinant of A.', 'det(A) = (1)(4) - (2)(3) = 4 - 6 = -2. The determinant is a scalar value computed from the matrix entries.', None))  
problems.append(('17. Optimization', 'Find the maximum value of y = -x2 + 4x.', 'The vertex of the parabola is at x = -b/(2a) = -4/(2*-1) = 2. Then y = -(2)2 + 4(2) = -4 + 8 = 4. Maximum is 4 at x = 2.', 'g17.png'))  
problems.append(('18. Rational Functions', 'Find the vertical asymptote of y = 1/(x-1).', 'The vertical asymptote occurs where the denominator is zero: x - 1 = 0, so x = 1. The function approaches infinity near this line.', 'g18.png'))  
problems.append(('19. Absolute Value', 'Solve |x| = 5.', 'The absolute value of x equals 5 when x = 5 or x = -5. The graph of y = |x| is V-shaped with vertex at the origin.', 'g19.png'))  
problems.append(('20. Cubic Functions', 'Find the roots of y = x3 - 3x.', 'Factor: x(x2 - 3) = 0, so x = 0, x = sqrt(3), x = -sqrt(3). The cubic has three real roots.', 'g20.png'))  
story = []  
story.append(Paragraph('Top 20 Math Problems', title_style))  
story.append(Spacer(1, 6))  
story.append(Paragraph('With Graphs and Step-by-Step Solutions', sub_style))  
story.append(Spacer(1, 4))  
story.append(Paragraph('A comprehensive practice guide covering algebra, calculus, geometry, trigonometry, statistics, and more.', sub_style))  
story.append(Spacer(1, 12))  
story.append(Paragraph('Table of Contents', h2_style))  
toc_items = []  
for i, (t, q, s, g) in enumerate(problems, 1):  
    toc_items.append([str(i), t])  
toc_table = Table(toc_items, colWidths=[0.5*inch, 6.0*inch])  
toc_table.setStyle(TableStyle([('GRID',(0,0),(-1,-1),0.5,colors.HexColor('#cccccc')),('BACKGROUND',(0,0),(0,-1),colors.HexColor('#eef2f7')),('FONTSIZE',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3)]))  
story.append(toc_table)  
story.append(PageBreak())  
for i, (t, q, s, g) in enumerate(problems, 1):  
    story.append(Paragraph(t, h2_style))  
    story.append(Paragraph('<b>Problem:</b> ' + q, body_style))  
    story.append(Spacer(1, 4))  
    story.append(Paragraph('<b>Solution:</b> ' + s, sol_style))  
    if g:  
        img_path = os.path.join(OUT_DIR, g)  
        if os.path.exists(img_path):  
            story.append(Spacer(1, 6))  
            story.append(Image(img_path, width=4.2*inch, height=3.2*inch))  
    if i % 2 == 0:  
        story.append(PageBreak())  
    else:  
        story.append(Spacer(1, 10))  
